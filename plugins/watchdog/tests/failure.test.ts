import { describe, expect, test } from 'claude-code/testing';
import { AUTO_MODE_DENY } from './fixtures/engine/auto-mode-deny';
import { PROMPT, stateIn, stubOnState } from './fixtures/on-state';
import {
  NOW,
  REVIEW_AGENT,
  SESSION_ID,
  START,
  USAGE,
  mainRow,
  stubAfterAtOnce,
  stubSession,
  subagentId,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, TurnCompleteInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<SessionEvents | 'state.get' | 'state.set' | 'session.attach' | 'prompt.submit' | 'clock.after'>;

const MINUTE = 60_000;
const OVERLOAD = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.';
const LIMIT = "You've hit your limit · resets 3pm (Europe/Rome)";
const TOO_LONG = 'Prompt is too long · the request is ~375704 tokens (limit 200000)';
const ON_STATE = { isOn: true, source: '/watchdog on' } as const;

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

type Seed = { state?: unknown; health?: unknown; spawnDeny?: string };

// A watched session with `$.state` stubbed (`on` and `health` seeded for a reload); `clock.after` runs its
// callback at once and keeps the wait.
const stub = (on: Stubs, seed: Seed = {}) => {
  const seen = stubSession(on, seed.spawnDeny === undefined ? {} : { spawnDeny: seed.spawnDeny });
  const state = stubOnState(on, seed);
  return { ...seen, ...state, delays: stubAfterAtOnce(on) };
};

// The prompts of the reviews the mod spawned (the test's own `SPAWN` reaches the stub too).
const reviews = (seen: { spawns: readonly { prompt: string }[] }): string[] =>
  seen.spawns.map((spawn) => spawn.prompt).filter((prompt) => prompt !== SPAWN.prompt);

// The kit's `session.append` rejects on 2.1.290 and accepts on 2.1.293: catch it, after the hooks saw the row.
const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

// One main turn whose end is a boundary; the engine's `agent.spawn` then teaches the id of the review.
const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
  await $.turn.complete(turnEnd(`t${n}`));
  await $.agent.spawn(SPAWN);
};

const step = async ($: Engine, agentId?: string): Promise<void> => {
  const stream = $.turn.step({
    turnId: 's1',
    index: 1,
    model: 'claude-opus-4-5',
    messageCount: 2,
    ...(agentId === undefined ? {} : { agentId }),
  });
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await stream.result;
};

const reviewEnd = (reason: 'answer' | 'error'): TurnCompleteInput => ({
  ...turnEnd('r1'),
  agentId: REVIEW_AGENT,
  reason,
  answer: '',
  ...(reason === 'error' ? {} : { usage: USAGE }),
});

// §12.1: the review fails at its first step; its agent's synthetic row holds the error text.
const failReview = async ($: Engine, text: string): Promise<void> => {
  await step($, REVIEW_AGENT);
  await append($, {
    uuid: 'x1',
    door: 'response',
    origin: { kind: 'model', model: '<synthetic>' },
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    agentId: REVIEW_AGENT,
  });
  await $.turn.complete(reviewEnd('error'));
};

const status = async ($: Engine): Promise<string[]> => ((await $.command.run(typed('status'))).text ?? '').split('\n');

describe('§12.1 to §12.3: a review that ends with reason "error"', () => {
  test('one failure: no row, `fail 1/3` and the last error, the count in $.state, the batch back in front', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    const logsBefore = seen.logs.length;
    await failReview($, OVERLOAD);

    expect(seen.logs.slice(logsBefore)).toEqual([]);
    expect(seen.logWrites.at(-1)).toContainEqual(
      expect.objectContaining({ kind: 'review', reason: 'error', steps: 1, error: OVERLOAD })
    );
    expect(reviews(seen)).toHaveLength(1);
    expect(await status($)).toEqual([
      'watchdog on · nudge 0/1 · blocker 0/2 · cooldown 0',
      'on source: /watchdog on',
      'default idle · fail 1/3',
      `last error: default: ${OVERLOAD}`,
    ]);
    expect(seen.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 1, refused: 0 } },
      lastError: `default: ${OVERLOAD}`,
    });

    await mainTurn($, 2);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toMatch(/Task 1\.[\s\S]*Task 2\./u);
  });

  test('the 3rd failure in a row halts with one row and drops the backlog; boundaries wait', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await failReview($, OVERLOAD);
    await mainTurn($, 2);
    await failReview($, OVERLOAD);
    await mainTurn($, 3);
    const logsBefore = seen.logs.length;
    await failReview($, OVERLOAD);

    expect(seen.logs.slice(logsBefore)).toEqual([`watchdog: default halted: ${OVERLOAD}`]);
    expect((await status($))[2]).toBe(`default halted: ${OVERLOAD} · retry after 09:10 UTC`);
    expect(seen.healthWrites.at(-1)).toMatchObject({
      watchdogs: {
        default: {
          problem: { state: 'halted', reason: OVERLOAD, tries: 0, nextTryAt: NOW + 5 * MINUTE },
          failures: 3,
        },
      },
    });

    await append($, mainRow('u4', 'user', 'Task 4.'));
    await $.turn.complete(turnEnd('t4'));
    expect(reviews(seen)).toHaveLength(3);
    expect(seen.logs.slice(logsBefore)).toHaveLength(1);
  });

  test('the halt drops the backlog in $.state at once, so a reload does not bring it back', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await failReview($, OVERLOAD);
    await mainTurn($, 2);
    await failReview($, OVERLOAD);
    await mainTurn($, 3);
    await failReview($, OVERLOAD);

    expect(stateIn(seen, SESSION_ID, 'feed')).toMatchObject({ cursors: { default: 'u3' } });
  });

  test('billing halts at the first failure', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await failReview($, 'Credit balance is too low');
    expect(seen.logs.at(-1)).toBe('watchdog: default halted: Credit balance is too low');
  });

  test('the halt drops the backlog of each watched agent; the try reviews only the updates since the halt', async ($, on: Stubs) => {
    const files: Record<string, WorkspaceFile> = {
      '/repo/WATCHDOG.json': { text: JSON.stringify({ subagents: { Explore: true } }), mtimeMs: 1 },
    };
    const explore: AgentSpawnInput = {
      ...SPAWN,
      tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001',
      prompt: 'Find where the auth token is parsed.',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
    };
    const time = { now: NOW };
    const seen = stubSession(on, { files, now: () => time.now });
    stubOnState(on);
    stubAfterAtOnce(on);
    await startOn($);
    await mainTurn($, 1);
    // Explore closes an update while the review of turn 1 runs: the subagent backlog waits.
    await $.agent.spawn(explore);
    const sub = subagentId(explore.tool_use_id);
    await append($, { ...mainRow('s1', 'assistant', 'Searching for the token parser.'), agentId: sub });
    await $.turn.complete({ ...turnEnd('s1'), agentId: sub });
    await failReview($, OVERLOAD);
    await mainTurn($, 2);
    await failReview($, OVERLOAD);
    await mainTurn($, 3);
    await failReview($, OVERLOAD);
    await mainTurn($, 4);

    time.now = NOW + 5 * MINUTE;
    await $.prompt.submit(PROMPT);
    expect(reviews(seen).at(-1)).toMatch(/Task 4\./u);
    expect(reviews(seen).at(-1)).not.toMatch(/Searching for the token parser/u);
  });
});

// The `$.state` value `health` of a halted default watchdog, as a reload finds it.
const halted = (nextTryAt: number) => ({
  watchdogs: {
    default: { problem: { state: 'halted', reason: OVERLOAD, tries: 0, nextTryAt }, failures: 3, refused: 0 },
  },
  lastError: `default: ${OVERLOAD}`,
});

describe('§12.3 items 2, 3: the try at a person prompt', () => {
  test('a reload sets the halt and its wait again; the first person prompt after it tries one review', async ($, on: Stubs) => {
    const seen = stub(on, { state: ON_STATE, health: halted(NOW) });
    await $.session.start(START);
    expect((await status($))[2]).toBe(`default halted: ${OVERLOAD} · retry after 09:05 UTC`);

    await append($, mainRow('u1', 'user', 'Task 1.'));
    await $.turn.complete(turnEnd('t1'));
    expect(reviews(seen)).toEqual([]);

    await $.prompt.submit(PROMPT);
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toContain('Task 1.');
    await $.agent.spawn(SPAWN);
    await $.turn.complete(reviewEnd('answer'));

    expect(seen.logs).toEqual(['watchdog: default is back']);
    expect((await status($))[2]).toBe('default idle');
  });

  test('before the next-try time a person prompt tries nothing', async ($, on: Stubs) => {
    const seen = stub(on, { state: ON_STATE, health: halted(NOW + 1) });
    await $.session.start(START);
    await append($, mainRow('u1', 'user', 'Task 1.'));
    await $.turn.complete(turnEnd('t1'));
    await $.prompt.submit(PROMPT);
    expect(reviews(seen)).toEqual([]);
  });

  test('a subscription limit gives `limited` with one row and tries at the next person prompt only', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await failReview($, LIMIT);
    expect(seen.logs.at(-1)).toBe(`watchdog: default limited: ${LIMIT}`);
    expect((await status($))[2]).toBe(`default limited: ${LIMIT}`);

    await append($, mainRow('u2', 'user', 'Task 2.'));
    await $.turn.complete(turnEnd('t2'));
    await $.prompt.submit({ ...PROMPT, origin: { kind: 'task-notification' } });
    expect(reviews(seen)).toHaveLength(1);

    await $.prompt.submit(PROMPT);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toMatch(/Task 1\.[\s\S]*Task 2\./u);
  });

  test('/watchdog on ends a halt at once, with the `is back` row 300 ms later', async ($, on: Stubs) => {
    const seen = stub(on, { state: ON_STATE, health: halted(NOW + MINUTE) });
    await $.session.start(START);
    await $.command.run(typed('on'));
    expect(seen.delays).toEqual([300]);
    expect(seen.logs).toEqual(['watchdog: default is back']);
    expect((await status($))[2]).toBe('default idle');
  });
});

describe('§12.2, §12.3: the other ends', () => {
  test('a prompt too large at step 0 retries once at once; still too large drops it and counts 1', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await failReview($, TOO_LONG);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toContain('Task 1.');

    await $.agent.spawn(SPAWN);
    await failReview($, TOO_LONG);
    expect(reviews(seen)).toHaveLength(2);
    expect((await status($))[2]).toBe('default idle · fail 1/3');
    await mainTurn($, 2);
    expect(reviews(seen).at(-1)).not.toContain('Task 1.');
  });

  test('a refusal counts no failure, moves the cursor and shows a refused count', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await $.turn.complete({
      ...reviewEnd('answer'),
      reason: 'refusal',
      refusal: { category: 'cyber', explanation: null },
    });
    expect((await status($))[2]).toBe('default idle · refused 1');
    expect(seen.logWrites.at(-1)).toContainEqual(
      expect.objectContaining({ kind: 'review', reason: 'refusal', refusal: 'cyber', error: null })
    );
    await mainTurn($, 2);
    expect(reviews(seen).at(-1)).not.toContain('Task 1.');
  });

  test('a model that the roster alias does not match gives `no_model` with one row; no next review', async ($, on: Stubs) => {
    const seen = stub(on);
    await startOn($);
    await mainTurn($, 1);
    await append($, mainRow('u2', 'user', 'Task 2.'));
    await step($);
    await $.turn.complete({ ...reviewEnd('answer'), usage: { ...USAGE, model: 'claude-sonnet-5-5' } });

    expect(seen.logs.at(-1)).toBe('watchdog: default no_model: availableModels gave claude-sonnet-5-5');
    expect(reviews(seen)).toHaveLength(1);
  });

  test('a permission deny of the spawn gives `blocked` with one row and keeps the deny text', async ($, on: Stubs) => {
    const deny = "Agent type 'watchdog:default' has been denied by permission rule 'Agent(watchdog:default)'.";
    const seen = stub(on, { spawnDeny: deny });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Task 1.'));
    await $.turn.complete(turnEnd('t1'));

    expect(seen.logs.at(-1)).toBe(`watchdog: default blocked: ${deny}`);
    expect(seen.logWrites.at(-1)).toContainEqual(
      expect.objectContaining({ kind: 'error', error: `review spawn failed: ${deny}` })
    );
    expect((await status($)).slice(2)).toEqual([`default blocked: ${deny}`, `last error: default: ${deny}`]);
    await append($, mainRow('u2', 'user', 'Task 2.'));
    await $.turn.complete(turnEnd('t2'));
    expect(reviews(seen)).toHaveLength(1);
  });

  test('an auto-mode deny of the spawn gives `blocked` by auto mode with a hint; no failure counts', async ($, on: Stubs) => {
    const seen = stub(on, { spawnDeny: AUTO_MODE_DENY });
    const blockedLines = [
      'default blocked: auto mode · switch the permission mode, or /watchdog on to retry',
      `last error: default: ${AUTO_MODE_DENY}`,
    ];
    const boundary = async (n: number): Promise<void> => {
      await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
      await $.turn.complete(turnEnd(`t${n}`));
    };
    await startOn($);
    await boundary(1);

    expect(seen.logs.at(-1)).toBe('watchdog: default blocked: auto mode');
    expect(seen.logWrites.at(-1)).toContainEqual(
      expect.objectContaining({ kind: 'error', error: `review spawn failed: ${AUTO_MODE_DENY}` })
    );
    expect((await status($)).slice(2)).toEqual(blockedLines);
    await boundary(2);
    await boundary(3);
    await boundary(4);
    expect(reviews(seen)).toHaveLength(1);

    // §12.3 item 6: only `/watchdog on` tries again, at the next boundary; a second deny is `blocked` again, never
    // `halted`, and the hint stays.
    await $.command.run(typed('on'));
    await boundary(5);
    expect(reviews(seen)).toHaveLength(2);
    expect((await status($)).slice(2)).toEqual(blockedLines);
  });
});
