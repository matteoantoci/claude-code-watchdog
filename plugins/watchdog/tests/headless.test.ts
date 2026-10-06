import { describe, expect, test } from 'claude-code/testing';
import { badValueWarning, envSwitch, settingsEnvWarning } from '../hooks/lifecycle/headless';
import { dropBacklog, isUnboundReject, waitingUpdates } from '../hooks/review/backlog';
import { REVIEW_SPAWN, sendNote, stubDelivery, wrapped } from './fixtures/delivery';
import { stubOnState } from './fixtures/on-state';
import {
  HEADLESS_START,
  HOME,
  REVIEW_AGENT,
  SESSION_ID,
  START,
  USAGE,
  mainRow,
  stubSession,
  subagentId,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents } from './fixtures/delivery';
import type { OnStateStubs } from './fixtures/on-state';
import type { SessionEvents, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The end of a `-p` run: the engine's end step and the dump file it leaves.
type EndEvents = 'session.end' | 'fs.write';

type Stubs = OnEvents<SessionEvents | EndEvents>;

type DeliveryEndStubs = OnEvents<DeliveryEvents | EndEvents>;

type PromptStubs = OnEvents<SessionEvents | 'prompt.submit'>;

type Written = { path: string; text: string }[];

const stubEnd = (on: OnEvents<EndEvents>): Written => {
  const written: Written = [];
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  return written;
};

const ENV_ON = { HOME, CLAUDE_WATCHDOG: 'on' };

const ON_STATUS = 'watchdog on · nudge 0/1 · cooldown 0\non source: CLAUDE_WATCHDOG\ndefault idle';

const END = { reason: 'other', sessionId: SESSION_ID, resume: { id: SESSION_ID } } as const;

// The engine's prompt of a `-p` or SDK run: a person prompt (§10).
const SDK_PROMPT = { text: 'Fix the parser.', wait: false, origin: { kind: 'sdk' } } as const;

const CONCERN = 'parseDate drops the timezone';

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

// One main turn with a prompt row and an answer row; its `turn.complete` closes one update.
const mainTurn = async ($: Engine, turnId: string): Promise<void> => {
  await append($, mainRow(`u-${turnId}`, 'user', `Prompt of ${turnId}.`));
  await append($, mainRow(`a-${turnId}`, 'assistant', `Answer of ${turnId}.`));
  await $.turn.complete(turnEnd(turnId));
};

const status = async ($: Engine): Promise<string> => (await $.command.run(typed('status'))).text ?? '';

// A headless run on CLAUDE_WATCHDOG: an sdk turn t1 that ended, then a late concern of the review.
const lateConcern = async ($: Engine): Promise<void> => {
  await $.session.start(HEADLESS_START);
  await $.agent.spawn(REVIEW_SPAWN);
  await $.prompt.submit(SDK_PROMPT);
  await $.turn.start({ text: SDK_PROMPT.text, turnId: 't1' });
  await $.turn.complete(turnEnd('t1'));
  await sendNote($, 'concern', CONCERN);
};

describe('the CLAUDE_WATCHDOG switch', () => {
  const none = { project: {}, local: {} };

  test('on and 1 turn on; unset and empty do nothing; each other value keeps off with a warning', () => {
    expect(envSwitch('on', none)).toEqual({ isOn: true });
    expect(envSwitch('1', none)).toEqual({ isOn: true });
    expect(envSwitch(undefined, none)).toEqual({ isOn: false });
    expect(envSwitch('', none)).toEqual({ isOn: false });
    expect(envSwitch('ON', none)).toEqual({ isOn: false, warning: badValueWarning('ON') });
  });

  test('a project or local env value of it keeps the session off, whatever the value', () => {
    const set = { env: { CLAUDE_WATCHDOG: 'on' } };
    expect(envSwitch('on', { ...none, project: set })).toEqual({ isOn: false, warning: settingsEnvWarning('project') });
    expect(envSwitch('yes', { ...none, local: set })).toEqual({ isOn: false, warning: settingsEnvWarning('local') });
    expect(envSwitch('on', { ...none, project: { env: { OTHER: '1' } } })).toEqual({ isOn: true });
  });
});

describe('the -p backlog', () => {
  const rows = ['r1', 'r2', 'r3'].map((uuid) => ({ uuid, text: uuid }));
  const ends = [
    { uuid: 'r1', close: 'step' },
    { uuid: 'r3', close: 'turn' },
  ] as const;
  const feed = { rows, ends, cursors: { default: null }, prompts: 0 };

  test('the updates after a cursor or a batch end', () => {
    expect(waitingUpdates(feed, null)).toBe(2);
    expect(waitingUpdates(feed, 'r1')).toBe(1);
    expect(waitingUpdates(feed, 'r3')).toBe(0);
  });

  test('a dropped backlog leaves no update', () => {
    const dropped = dropBacklog(feed, 'default');
    expect(dropped.cursors).toEqual({ default: 'r3' });
    expect(waitingUpdates(dropped, dropped.cursors['default'])).toBe(0);
  });

  test('only the unbound reject drops the backlog', () => {
    expect(isUnboundReject('no session is bound')).toBe(true);
    expect(isUnboundReject('rate limited')).toBe(false);
  });
});

describe('CLAUDE_WATCHDOG at session.start', () => {
  test('a headless session with CLAUDE_WATCHDOG=on turns on at once and unsets the variable', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
    expect(seen.agents.map((agent) => agent.name)).toEqual(['default']);
    expect(seen.preflights).toHaveLength(1);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
  });

  test('1 turns a headless session on too', async ($, on: Stubs) => {
    stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: '1' } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });

  test('an interactive session unsets CLAUDE_WATCHDOG and ignores it', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    await $.session.start(START);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    expect(seen.settingsReads).toEqual([]);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
  });

  test('an unset or empty variable does nothing and leaves no dump', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: '' } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    await $.session.end(END);
    expect(seen.settingsReads).toEqual([]);
    expect(written).toEqual([]);
  });

  test('another value leaves a headless session off with one dump warning', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: 'yes' } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    await $.session.end(END);
    expect(written.map((write) => write.path)).toEqual([
      `${HOME}/.claude/watchdog/dumps/${SESSION_ID}-20261006-090503.md`,
    ]);
    expect(written[0]?.text).toContain(`- warning: ${badValueWarning('yes')}`);
  });

  test('the project and local settings are the sources read; their env value keeps the session off', async ($, on: Stubs) => {
    const env = { CLAUDE_WATCHDOG: 'on' };
    const seen = stubSession(on, { env: ENV_ON, settings: { local: { env } } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(seen.settingsReads).toEqual(['project', 'local']);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
    await $.session.end(END);
    expect(written[0]?.text).toContain(`- warning: ${settingsEnvWarning('local')}`);
  });

  test('a project env value keeps it off, also when the user settings set it too', async ($, on: Stubs) => {
    const env = { CLAUDE_WATCHDOG: 'on' };
    stubSession(on, { env: ENV_ON, settings: { project: { env }, user: { env } } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    await $.session.end(END);
    expect(written[0]?.text).toContain(`- warning: ${settingsEnvWarning('project')}`);
  });

  test('user settings and the shell can turn it on', async ($, on: Stubs) => {
    stubSession(on, { env: ENV_ON, settings: { user: { env: { CLAUDE_WATCHDOG: 'on' } } } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });

  test('a reload keeps the on state though the variable is gone', async ($, on: OnStateStubs) => {
    stubSession(on);
    stubOnState(on, { state: { isOn: true, source: 'CLAUDE_WATCHDOG' } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });
});

describe('delivery in -p', () => {
  test('a late concern sends no nudge and waits as an aside for the next sdk prompt', async ($, on: DeliveryEndStubs) => {
    const seen = stubDelivery(on, { env: ENV_ON });
    await lateConcern($);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (aside on next prompt)`);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
    await seen.clock.advance(2000);
    expect(seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>'))).toEqual([]);
    await $.prompt.submit(SDK_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });

  test('session.end writes the dump file with the note that still waits', async ($, on: DeliveryEndStubs) => {
    stubDelivery(on, { env: ENV_ON });
    const written = stubEnd(on);
    await lateConcern($);
    await $.session.end(END);
    expect(written.map((write) => write.path)).toEqual([
      `${HOME}/.claude/watchdog/dumps/${SESSION_ID}-20261006-090503.md`,
    ]);
    expect(written[0]?.text).toContain(`- waiting: [concern] default: ${CONCERN} (aside on next prompt)`);
  });

  test('a steer with no tool result before the turn ended waits as an aside', async ($, on: DeliveryEndStubs) => {
    const seen = stubDelivery(on, { env: ENV_ON });
    await $.session.start(HEADLESS_START);
    await $.agent.spawn(REVIEW_SPAWN);
    await $.prompt.submit(SDK_PROMPT);
    await $.turn.start({ text: SDK_PROMPT.text, turnId: 't1' });
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (steered)`);
    await $.turn.complete(turnEnd('t1'));
    await seen.clock.advance(2000);
    expect(seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>'))).toEqual([]);
    await $.prompt.submit(SDK_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });
});

describe('the person prompt of -p (§7.6, §7.7, §10)', () => {
  // Over the 120-char one-line cut of a row that is not a person prompt.
  const TYPED =
    'Use the Read tool to read math.js, then read a.txt, one tool call at a time. Then tell me in one line what add(2, 3) returns.';

  test('its row, which the engine stamps unclassified, reaches the review uncut and in part 2', async ($, on: PromptStubs) => {
    const seen = stubSession(on, {
      env: ENV_ON,
      messages: [{ role: 'user', content: [{ type: 'text', text: TYPED }] }],
    });
    // The engine appends the prompt's row while the `-p` prompt submits, with origin `unclassified` though the
    // submit's origin is `sdk` (live probe l3-headless-prompt).
    on('prompt.submit', async (_$, e) => {
      const content = [{ type: 'text', text: e.text }];
      await append($, {
        uuid: 'u1',
        door: 'prompt',
        origin: { kind: 'unclassified' },
        message: { type: 'user', role: 'user', content },
      });
      return { text: e.text };
    });
    await $.session.start(HEADLESS_START);
    await $.prompt.submit({ ...SDK_PROMPT, text: TYPED });
    await append($, mainRow('a1', 'assistant', 'add(2, 3) returns -1.'));
    await $.turn.complete(turnEnd('t1'));

    const prompt = seen.spawns[0]?.prompt ?? '';
    expect(prompt).toContain(
      `### The person's prompts since the watchdog started (newest first)\n\n**user**:\n${TYPED}`
    );
    expect(prompt).toContain(`### Session update\n\n**user**:\n${TYPED}\n\n**agent**:\nadd(2, 3) returns -1.`);
    expect(prompt).not.toContain('[unclassified]');
  });

  test('an unclassified prompt row outside a person submit stays one tagged line', async ($, on: PromptStubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    on('prompt.submit', (_$, e) => ({ text: e.text }));
    await $.session.start(HEADLESS_START);
    await $.prompt.submit({ ...SDK_PROMPT, text: 'Read math.js.' });
    const content = [{ type: 'text', text: TYPED }];
    await append($, {
      uuid: 'u1',
      door: 'prompt',
      origin: { kind: 'unclassified' },
      message: { type: 'user', role: 'user', content },
    });
    await $.turn.complete(turnEnd('t1'));

    expect(seen.spawns[0]?.prompt).toMatch(/^### Session update\n\n\[unclassified\] Use the Read tool.{80,}…$/u);
  });
});

describe('backlog at the end of -p', () => {
  test('a no session is bound spawn reject drops the backlog with an unreviewed record', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON, spawnDeny: 'no session is bound' });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    expect(seen.spawns).toHaveLength(2);
    expect(await status($)).toBe(ON_STATUS);
    await $.session.end(END);
    const text = written[0]?.text ?? '';
    // One record for each reject, each with the update since the last; session.end finds no backlog left.
    expect(text.match(/unreviewed: \d+ updates/gu)).toEqual(['unreviewed: 1 updates', 'unreviewed: 1 updates']);
    expect(text).toContain('### 2026-10-06T09:05:03Z · default · unreviewed: 1 updates');
  });

  test('session.end records each backlog that no review took', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    await mainTurn($, 't3');
    expect(seen.spawns).toHaveLength(1);
    await $.session.end(END);
    expect(written[0]?.text).toContain('### 2026-10-06T09:05:03Z · default · unreviewed: 2 updates');
  });

  test('an interactive session writes no dump file at its end', async ($, on: Stubs) => {
    stubSession(on);
    const written = stubEnd(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    await $.session.end(END);
    expect(written).toEqual([]);
  });
});

describe('the backlog of a watched subagent at the end of -p (§7.5, §11.2)', () => {
  const EXPLORE_ON: Record<string, WorkspaceFile> = {
    '/repo/WATCHDOG.json': { text: JSON.stringify({ subagents: { Explore: true } }), mtimeMs: 1 },
  };
  const EXPLORE: AgentSpawnInput = {
    tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001',
    prompt: 'Find where the auth token is parsed.',
    description: 'explore auth',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-4-5',
    background: true,
    fork: false,
  };
  const SUB = subagentId(EXPLORE.tool_use_id);

  // The review of t1 runs; meanwhile Explore closes 2 updates (a step boundary and its end) that wait.
  const subagentBacklog = async ($: Engine): Promise<void> => {
    await $.session.start(HEADLESS_START);
    await mainTurn($, 't1');
    await $.agent.spawn(REVIEW_SPAWN);
    await $.agent.spawn(EXPLORE);
    await append($, { ...mainRow('s1', 'assistant', 'Searching for the token parser.'), agentId: SUB });
    const stream = $.turn.step({ turnId: 's1', index: 1, model: 'claude-haiku-4-5', messageCount: 2, agentId: SUB });
    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
    }
    await stream.result;
    await append($, { ...mainRow('s2', 'assistant', 'Found it in auth/token.ts.'), agentId: SUB });
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
  };

  test('the unbound reject of its review drops the subagent backlog it took; the primary one waits for session.end', async ($, on: Stubs) => {
    const unbound = { isOn: false };
    on('agent.spawn', { prompt: /^/u }, (_$, e, next) => {
      const type = String('subagent_type' in e ? e.subagent_type : e.subagentType);
      return unbound.isOn && type.startsWith('watchdog:') ? { deny: 'no session is bound' } : next(e);
    });
    stubSession(on, { env: ENV_ON, files: EXPLORE_ON });
    const written = stubEnd(on);
    await subagentBacklog($);
    await mainTurn($, 't2');
    unbound.isOn = true;
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
    await $.session.end(END);

    // The reject's record counts the 2 subagent updates; session.end's counts t2 of the primary agent.
    expect(written[0]?.text.match(/unreviewed: \d+ updates/gu)).toEqual([
      'unreviewed: 2 updates',
      'unreviewed: 1 updates',
    ]);
  });

  test('session.end records the subagent backlog that no review took', async ($, on: Stubs) => {
    stubSession(on, { env: ENV_ON, files: EXPLORE_ON });
    const written = stubEnd(on);
    await subagentBacklog($);
    await $.session.end(END);

    expect(written[0]?.text.match(/unreviewed: \d+ updates/gu)).toEqual(['unreviewed: 2 updates']);
  });
});
