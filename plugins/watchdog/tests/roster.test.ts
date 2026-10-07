import { describe, expect, test } from 'claude-code/testing';
import { HOME, REVIEW_AGENT, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, TurnStepInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The test answers `$.clock.after` at once, so a delayed log row lands before the command resolves.
type Stubs = OnEvents<SessionEvents | 'clock.after'>;

const USER_FILE = `${HOME}/.claude/WATCHDOG.json`;
const PROJECT_FILE = '/repo/WATCHDOG.json';
const PROJECT_CLAUDE_FILE = '/repo/.claude/WATCHDOG.json';

// The engine's `agent.spawn` of a review of watchdog `a`, as the Agent tool fires it.
const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
  prompt: 'review',
  description: 'watchdog a review',
  subagentType: 'watchdog:a',
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

const file = (doc: unknown, mtimeMs = 1): WorkspaceFile => ({ text: JSON.stringify(doc), mtimeMs });

const stub = (on: Stubs, files: Record<string, WorkspaceFile>) => {
  on('clock.after', () => ({ value: undefined }));
  return stubSession(on, { files });
};

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

// The first two status lines while on; the roster lines follow them.
const ON_HEAD = 'watchdog on · nudge 0/1 · blocker 0/2 · cooldown 0\non source: /watchdog on';

const status = async ($: Engine): Promise<string> => (await $.command.run(typed('status'))).text ?? '';

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const step = async ($: Engine, e: TurnStepInput): Promise<void> => {
  const stream = $.turn.step(e);
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  await stream.result;
};

const mainStep = (index: number, effort?: TurnStepInput['effort']): TurnStepInput => ({
  turnId: 't1',
  index,
  model: 'claude-opus-4-5',
  messageCount: 2,
  ...(effort === undefined ? {} : { effort }),
});

describe('roster from WATCHDOG.json (§4.2, §4.3)', () => {
  test('each enabled watchdog registers with its model, effort and tools; the status names its file', async ($, on: Stubs) => {
    const roster = {
      watchdogs: [
        { name: 'Security', model: 'anthropic/sonnet:high', tools: ['read'] },
        { name: 'style', enabled: false },
      ],
    };
    const seen = stub(on, { [PROJECT_FILE]: file(roster) });
    await startOn($);

    expect(seen.agents.map(({ name, model, effort, tools }) => ({ name, model, effort, tools }))).toEqual([
      {
        name: 'security',
        model: 'sonnet',
        effort: 'high',
        tools: ['Read', 'mcp__watchdog__note', 'mcp__watchdog__resolve'],
      },
    ]);
    expect(seen.preflights.map((request) => request.model)).toEqual(['sonnet']);
    expect(await status($)).toBe(`${ON_HEAD}\nSecurity idle · ./WATCHDOG.json\nstyle disabled · ./WATCHDOG.json`);
  });

  test('the user file loads first; a project entry with the same slug replaces it', async ($, on: Stubs) => {
    const seen = stub(on, {
      [USER_FILE]: file({ watchdogs: [{ name: 'security', model: 'haiku' }, { name: 'docs' }] }),
      [PROJECT_CLAUDE_FILE]: file({ watchdogs: [{ name: 'Security' }] }),
    });
    await startOn($);

    expect(seen.agents.map(({ name, model }) => ({ name, model }))).toEqual([
      { name: 'security', model: 'opus' },
      { name: 'docs', model: 'opus' },
    ]);
    expect(await status($)).toBe(
      `${ON_HEAD}\nSecurity idle · ./.claude/WATCHDOG.json\ndocs idle · ~/.claude/WATCHDOG.json`
    );
  });

  test('watchdogs [] gives zero watchdogs: no agent, no preflight, no review', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [] }) });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Hi.'));
    await $.turn.complete(turnEnd('t1'));

    expect(seen.agents).toEqual([]);
    expect(seen.preflights).toEqual([]);
    expect(seen.spawns).toEqual([]);
    expect(await status($)).toBe(ON_HEAD);
  });

  test('another provider gives no_model with the reason and no preflight call', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [{ name: 'gpt', model: 'openai/gpt-5' }] }) });
    await startOn($);

    expect(seen.agents).toEqual([]);
    expect(seen.preflights).toEqual([]);
    expect(await status($)).toBe(
      `${ON_HEAD}\ngpt no_model: provider "openai" is not supported; only anthropic works now · ./WATCHDOG.json`
    );
  });
});

describe('warnings (§4.6)', () => {
  test('the status lists every warning, and one log row shows the count', async ($, on: Stubs) => {
    const seen = stub(on, {
      [USER_FILE]: file({ watchdogs: [{ name: 'a', tools: ['Bash'] }] }),
      [PROJECT_FILE]: { text: '{ "watchdogs": ', mtimeMs: 1 },
    });
    await startOn($);

    expect(seen.logs).toEqual(['2 WATCHDOG.json warnings; see /watchdog status']);
    expect((await status($)).split('\n')).toEqual([
      'watchdog on · nudge 0/1 · blocker 0/2 · cooldown 0',
      'on source: /watchdog on',
      'a idle · ~/.claude/WATCHDOG.json',
      'warning: ~/.claude/WATCHDOG.json: watchdog "a": tool "Bash" is refused; tool dropped',
      expect.stringMatching(/^warning: \.\/WATCHDOG\.json: not valid JSON; file skipped/u),
    ]);
  });

  test('a roster with no warning writes no log row', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [{ name: 'a' }] }) });
    await startOn($);
    expect(seen.logs).toEqual([]);
  });
});

describe('frozen at /watchdog on (§4.5)', () => {
  test('a changed file shows "config changed" and takes effect after off and on', async ($, on: Stubs) => {
    const files = { [PROJECT_FILE]: file({ watchdogs: [{ name: 'a' }] }) };
    const seen = stub(on, files);
    await startOn($);
    expect(await status($)).toBe(`${ON_HEAD}\na idle · ./WATCHDOG.json`);

    files[PROJECT_FILE] = file({ watchdogs: [{ name: 'b' }] }, 2);
    expect(await status($)).toBe(
      `${ON_HEAD}\na idle · ./WATCHDOG.json\nconfig changed: /watchdog off, then /watchdog on to load it`
    );
    expect(seen.agents.map((agent) => agent.name)).toEqual(['a']);

    await $.command.run(typed('off'));
    await $.command.run(typed('on'));
    expect(seen.agents.map((agent) => agent.name)).toEqual(['a', 'b']);
    expect(await status($)).toBe(`${ON_HEAD}\nb idle · ./WATCHDOG.json`);
  });

  test('a file that appears after /watchdog on also shows "config changed"', async ($, on: Stubs) => {
    const files: Record<string, WorkspaceFile> = {};
    stub(on, files);
    await startOn($);
    files[PROJECT_CLAUDE_FILE] = file({ watchdogs: [] });
    expect(await status($)).toContain('config changed');
  });
});

describe(':auto effort (§6.2)', () => {
  test('auto takes the session effort at review start and registers again only when it changed', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [{ name: 'a', model: 'opus:auto' }] }) });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Refactor the parser.'));
    await step($, mainStep(0, 'xhigh'));
    await $.turn.complete(turnEnd('t1'));
    expect(seen.agents.map((agent) => agent.effort)).toEqual(['medium', 'xhigh']);
    expect(seen.spawns.length).toBe(1);

    // The mod learns the review's id from the engine's `agent.spawn` (spec §16.2); its end frees the watchdog.
    await $.agent.spawn(SPAWN);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
    const spawnsBefore = seen.spawns.length;
    await append($, mainRow('u2', 'user', 'Now the lexer.'));
    await step($, { ...mainStep(0, 'xhigh'), turnId: 't2' });
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(spawnsBefore + 1);
    expect(seen.agents.map((agent) => agent.effort)).toEqual(['medium', 'xhigh']);
  });
});

describe('cadence (§7.4)', () => {
  test('agent-end: a turn.step boundary spawns nothing; the turn end reviews the whole turn', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [{ name: 'a', reviewMode: 'agent-end' }] }) });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Rename the module.'));
    await step($, mainStep(0));
    await append($, mainRow('a1', 'assistant', 'Reading it first.'));
    await step($, mainStep(1));
    expect(seen.spawns.length).toBe(0);

    await append($, mainRow('a2', 'assistant', 'Renamed.'));
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('Rename the module.');
    expect(seen.spawns[0]?.prompt).toContain('Renamed.');
  });

  test('reviewInterval 2: the skipped update goes with the next review', async ($, on: Stubs) => {
    const seen = stub(on, { [PROJECT_FILE]: file({ watchdogs: [{ name: 'a', reviewInterval: 2 }] }) });
    await startOn($);
    await append($, mainRow('u1', 'user', 'First task.'));
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(0);

    await append($, mainRow('u2', 'user', 'Second task.'));
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('First task.');
    expect(seen.spawns[0]?.prompt).toContain('Second task.');
  });
});
