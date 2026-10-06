import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_AGENT, SESSION_ID, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents } from './fixtures/session';
import type { AgentSpawnInput, RenderSurface } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<SessionEvents | 'session.surfaces' | 'fs.write' | 'ui.copy' | 'clock.after'>;

// The environment of the dump tests: the dump goes under `CLAUDE_CONFIG_DIR`.
const DUMP_ENV = { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/me' };

type Dumped = { writes: { path: string; text: string }[]; copies: string[]; delays: number[] };

// The engine's `agent.spawn` of a review, as the Agent tool fires it: the mod learns the id from `next(e)`.
const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
  prompt: 'review',
  description: 'watchdog default review',
  subagentType: 'watchdog:default',
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

type DumpOptions = { surfaces?: readonly RenderSurface[] };

// The `$` calls of `/watchdog dump`. `clock.after` resolves at once: the stub keeps the wait it was asked for.
const stubDump = (on: Stubs, options: DumpOptions = {}): Dumped => {
  const dumped: Dumped = { writes: [], copies: [], delays: [] };
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }));
  on('fs.write', (_$, e) => {
    dumped.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on('ui.copy', (_$, e) => {
    dumped.copies.push(e.text);
    return { value: { isCopied: true } };
  });
  on('clock.after', (_$, e) => {
    dumped.delays.push(e.ms);
    return { value: undefined };
  });
  return dumped;
};

// The kit has nothing beneath the plugins for `session.append`: the call rejects after the hooks saw the row.
const append = async ($: Engine, uuid: string, text: string): Promise<void> => {
  await $.session.append(mainRow(uuid, 'user', text)).catch(() => undefined);
};

const agentStep = async ($: Engine, index: number): Promise<void> => {
  const stream = $.turn.step({ turnId: 'r1', index, model: 'claude-opus-4-5', messageCount: 2, agentId: REVIEW_AGENT });
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await stream.result;
};

// One whole review: a main turn, the spawn, one nit (an aside, so no nudge waits), two agent steps, the
// agent's own `turn.complete`.
const runReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await append($, 'u1', 'Fix the date parser.');
  await $.turn.complete(turnEnd('t1'));
  await $.agent.spawn(SPAWN);
  await $.tool.call({
    tool: 'mcp__watchdog__note',
    agentId: REVIEW_AGENT,
    note: 'Check the null branch.',
    severity: 'nit',
  });
  await agentStep($, 0);
  await agentStep($, 1);
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
};
describe('review log', () => {
  test('a review end writes one log record with its reason, steps, answer length and notes', async ($, on: Stubs) => {
    stubSession(on, { env: DUMP_ENV });
    const dumped = stubDump(on);
    await runReview($);
    await $.command.run(typed('dump'));

    const text = dumped.writes[0]?.text ?? '';
    expect(text.match(/^### /gmu)?.length).toBe(1);
    expect(text).toContain(
      [
        '### 2026-10-06T09:05:03Z · default · review afake0001',
        '- model: claude-opus-4-5, effort medium',
        '- end: answer, 2 steps, answer 4 chars',
        '- usage: 1200 input, 80 output, 0 cache read, 0 cache write',
        '- cost: $?',
        '- error: none',
        '- notes: 1',
        '  - [nit] Check the null branch. (aside on next prompt)',
        '- answer:',
        '',
        '> done',
      ].join('\n')
    );
  });
});

describe('/watchdog dump', () => {
  test('fs.write gets <config>/watchdog/dumps/<sessionId>-<time>.md and the records; the reply shows the path', async ($, on: Stubs) => {
    stubSession(on, { env: DUMP_ENV });
    const dumped = stubDump(on);
    await runReview($);
    const reply = await $.command.run(typed('dump'));

    const path = `/cfg/watchdog/dumps/${SESSION_ID}-20261006-090503.md`;
    expect(dumped.writes.map((write) => write.path)).toEqual([path]);
    expect(dumped.writes[0]?.text).toContain('### 2026-10-06T09:05:03Z · default · review afake0001');
    expect(dumped.writes[0]?.text).toContain('- end: answer, 2 steps, answer 4 chars');
    expect(dumped.writes[0]?.text).not.toContain('Fix the date parser.');
    expect(reply.text).toBe(`watchdog dump: ${path}`);
  });

  test('the terminal copies the dump text, and the log row waits 300 ms', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: DUMP_ENV });
    const dumped = stubDump(on);
    await runReview($);
    const logsBefore = seen.logs.length;
    await $.command.run(typed('dump'));

    expect(dumped.copies).toEqual([dumped.writes[0]?.text]);
    expect(dumped.delays).toEqual([300]);
    expect(seen.logs.slice(logsBefore)).toEqual(['dump copied to the clipboard']);
  });

  test('the desktop gets the file only', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: DUMP_ENV });
    const dumped = stubDump(on, { surfaces: ['desktop'] });
    await runReview($);
    const logsBefore = seen.logs.length;
    await $.command.run(typed('dump'));

    expect(dumped.writes.length).toBe(1);
    expect(dumped.copies).toEqual([]);
    expect(seen.logs.slice(logsBefore)).toEqual([]);
  });

  test('dump raw adds the review prompts; with no CLAUDE_CONFIG_DIR the path is under $HOME/.claude', async ($, on: Stubs) => {
    stubSession(on, { env: { HOME: '/home/me' } });
    const dumped = stubDump(on);
    await runReview($);
    const reply = await $.command.run(typed('dump raw'));

    const path = `/home/me/.claude/watchdog/dumps/${SESSION_ID}-20261006-090503.md`;
    expect(reply.text).toBe(`watchdog dump: ${path}`);
    expect(dumped.writes[0]?.path).toBe(path);
    expect(dumped.writes[0]?.text).toContain(
      '## Prompts of the last reviews\n\n### default\n\n> ### Session update\n>\n> **user**:\n> Fix the date parser.'
    );
  });

  test('a refused write replies with the error', async ($, on: Stubs) => {
    stubSession(on);
    on('fs.write', () => ({ deny: 'read-only file system' }));
    await $.session.start(START);
    const reply = await $.command.run(typed('dump'));

    // The kit names the call before the deny text.
    expect(reply.text).toMatch(/^watchdog dump failed: .*read-only file system$/u);
  });
});
