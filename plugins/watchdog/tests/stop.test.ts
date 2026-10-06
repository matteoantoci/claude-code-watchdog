import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_TIMEOUT_MS } from '../hooks/constants';
import { REVIEW_SPAWN, sendNote, stubDelivery } from './fixtures/delivery';
import { stubState } from './fixtures/on-state';
import {
  NOW,
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
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { SessionStubs, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, ToolCallResult } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type ClockStubs = DeliveryStubs & StateStubs;

type FallbackStubs = SessionStubs & StateStubs & OnEvents<'clock.after'>;

const TIMEOUT_ERROR = 'the review ran for more than 10 min';
const DROPPED = 'Dropped: the review was stopped.';

// The kit has nothing beneath the plugins for `session.append`: the call rejects after the hooks saw the row.
const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const step = async ($: Engine, turnId: string): Promise<void> => {
  const stream = $.turn.step({ turnId, index: 1, model: 'claude-opus-4-5', messageCount: 2 });
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await stream.result;
};

// §11.1: `WATCHDOG.json` opts the Explore type in; the engine's `agent.spawn` of the subagent it starts.
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

const subRow = (uuid: string, text: string): SessionAppendInput => ({
  ...mainRow(uuid, 'assistant', text),
  agentId: SUB,
});

// `/watchdog on`, the primary agent starts Explore, and the subagent's step 1 boundary spawns its review (§11.2),
// whose id the engine teaches.
const startSubagentReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.turn.start({ text: 'Fix the login bug.', turnId: 't1' });
  await $.agent.spawn(EXPLORE);
  await append($, subRow('s1', 'Searching for the token parser.'));
  const stream = $.turn.step({ turnId: 's1', index: 1, model: 'claude-haiku-4-5', messageCount: 2, agentId: SUB });
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  await stream.result;
  await $.agent.spawn(REVIEW_SPAWN);
};

// The subagent's next update, closed by its own end: a boundary of its backlog.
const subagentEnd = async ($: Engine): Promise<void> => {
  await append($, subRow('s2', 'Found it in auth/token.ts.'));
  await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
};

// One main turn whose end is a boundary: the mod spawns a review of its rows.
const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
  await $.turn.complete(turnEnd(`t${n}`));
};

// `/watchdog on`, a main turn, and the review's id as the engine's `agent.spawn` gives it.
const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await mainTurn($, 1);
  await $.agent.spawn(REVIEW_SPAWN);
};

const note = async ($: Engine, text: string): Promise<ToolCallResult> =>
  $.tool.call({ tool: 'mcp__watchdog__note', agentId: REVIEW_AGENT, note: text, severity: 'concern' });

// The stopped review's own end, as `TaskStop` makes it (§7.8).
const abortedEnd = async ($: Engine): Promise<void> => {
  await $.turn.complete({
    ...turnEnd('r1'),
    agentId: REVIEW_AGENT,
    reason: 'aborted',
    isAborted: true,
    answer: '',
    usage: USAGE,
  });
};

const status = async ($: Engine): Promise<string[]> => ((await $.command.run(typed('status'))).text ?? '').split('\n');

// The review prompts the mod spawned (the test's own `REVIEW_SPAWN` and the engine's subagent spawn reach the
// stub too).
const reviews = (seen: { spawns: readonly { prompt: string; subagentType: string }[] }): string[] =>
  seen.spawns
    .filter((spawn) => spawn.subagentType.startsWith('watchdog:') && spawn.prompt !== REVIEW_SPAWN.prompt)
    .map((spawn) => spawn.prompt);

// The records of the newest `log` write.
const records = (writes: readonly unknown[]): unknown[] => {
  const last = writes.at(-1);
  return Array.isArray(last) ? last : [];
};

describe('§7.8 the 10 min timeout', () => {
  test('the timer runs the timeout actions once: stop map first, TaskStop, 1 failure, batch back, slot free, record', async ($, on: ClockStubs) => {
    const stopsAtTaskStop: unknown[] = [];
    const seen = stubDelivery(on, { onTaskStop: () => stopsAtTaskStop.push(state.reviewsWrites.at(-1)) });
    const state = stubState(on);
    await startReview($);
    expect(await status($)).toContain('default reviewing');

    await seen.clock.advance(REVIEW_TIMEOUT_MS - 1);
    expect(seen.taskStops).toEqual([]);
    await seen.clock.advance(1);

    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(stopsAtTaskStop).toEqual([{ running: [], stops: [{ agentId: REVIEW_AGENT, reason: 'timeout' }] }]);
    expect(await status($)).toEqual(
      expect.arrayContaining(['default idle · fail 1/3', `last error: default: ${TIMEOUT_ERROR}`])
    );
    expect(state.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 1, refused: 0 } },
      lastError: `default: ${TIMEOUT_ERROR}`,
    });
    expect(records(state.logWrites)).toEqual([
      { kind: 'timeout', watchdog: 'default', agentId: REVIEW_AGENT, time: NOW + REVIEW_TIMEOUT_MS },
    ]);

    // The batch with no notes went back, so the next review takes both turns; the fallback check of the next
    // main turn end and step finds nothing more to stop.
    await mainTurn($, 2);
    await step($, 't3');
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toMatch(/Task 1\.[\s\S]*Task 2\./u);
  });

  test('a later note of the timed-out agent is dropped, and its aborted end only adds its usage to the cost', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on);
    const state = stubState(on);
    await startReview($);
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    const logs = seen.logs.length;

    expect(await note($, 'parseDate drops the timezone')).toEqual({ result: DROPPED });
    await abortedEnd($);

    expect(seen.logs.slice(logs)).toEqual([]);
    expect(await status($)).toContain('default idle · fail 1/3');
    // The timeout record is the review's one record; the ledger counts the review once, with the usage.
    expect(records(state.logWrites)).toEqual([expect.objectContaining({ kind: 'timeout', agentId: REVIEW_AGENT })]);
    expect(state.sessions.get(SESSION_ID)?.get('ledger')?.at(-1)).toMatchObject({
      session: { reviews: 1, notes: { blocker: 0, concern: 0, nit: 0 }, tokens: 1280, model: 'claude-opus-4-5' },
    });
  });

  test('a review that delivered a note keeps it and moves the cursor', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on);
    stubState(on);
    await startReview($);
    await note($, 'parseDate drops the timezone');
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    await mainTurn($, 2);

    expect(reviews(seen)[1]).not.toMatch(/Task 1\./u);
    expect(reviews(seen)[1]).toMatch(/Task 2\./u);
  });

  test('a TaskStop reject goes once to the dump, and the slot is free all the same', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on, { taskStopDeny: 'No task found with ID: afake0001' });
    const state = stubState(on);
    await startReview($);
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    await step($, 't2');
    await mainTurn($, 2);

    expect(records(state.logWrites)).toEqual([
      { kind: 'timeout', watchdog: 'default', agentId: REVIEW_AGENT, time: NOW + REVIEW_TIMEOUT_MS },
      {
        kind: 'error',
        watchdog: 'default',
        time: NOW + REVIEW_TIMEOUT_MS,
        error: 'TaskStop failed: No task found with ID: afake0001',
      },
    ]);
    expect(reviews(seen)).toHaveLength(2);
  });

  test('with no timer (a reload dropped it), the main step past 10 min runs the actions once', async ($, on: FallbackStubs) => {
    const time = { now: NOW };
    const seen = stubSession(on, { now: () => time.now });
    const state = stubState(on);
    on('clock.after', (_$, e) => (e.ms === REVIEW_TIMEOUT_MS ? { deny: 'dropped by a reload' } : { value: undefined }));
    await startReview($);
    time.now = NOW + REVIEW_TIMEOUT_MS - 1;
    await step($, 't2');
    expect(seen.taskStops).toEqual([]);

    time.now = NOW + REVIEW_TIMEOUT_MS;
    await step($, 't2');
    await $.turn.complete(turnEnd('t2'));
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(records(state.logWrites)).toEqual([
      { kind: 'timeout', watchdog: 'default', agentId: REVIEW_AGENT, time: NOW + REVIEW_TIMEOUT_MS },
    ]);
    expect(state.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 1, refused: 0 } },
      lastError: `default: ${TIMEOUT_ERROR}`,
    });
  });
});

describe('§5.2 `/watchdog off` stops each review', () => {
  test('stop map `off` before TaskStop, its notes go, no failure counts', async ($, on: ClockStubs) => {
    const stopsAtTaskStop: unknown[] = [];
    const seen = stubDelivery(on, { onTaskStop: () => stopsAtTaskStop.push(state.reviewsWrites.at(-1)) });
    const state = stubState(on);
    await startReview($);
    await note($, 'parseDate drops the timezone');
    await $.command.run(typed('off'));

    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(stopsAtTaskStop).toEqual([{ running: [], stops: [{ agentId: REVIEW_AGENT, reason: 'off' }] }]);
    expect(await note($, 'the migration deletes the users table')).toEqual({ result: DROPPED });
    await abortedEnd($);
    // Its result is dropped, so it writes no review record; its tokens still count in the cost (§15).
    expect(state.logWrites.flat()).not.toContainEqual(expect.objectContaining({ kind: 'review' }));
    expect(state.sessions.get(SESSION_ID)?.get('ledger')?.at(-1)).toMatchObject({
      session: { reviews: 1, tokens: 1280 },
    });
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);

    await $.command.run(typed('on'));
    expect(await status($)).toContain('default idle');
    expect(state.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 0, refused: 0 } },
      lastError: null,
    });
  });

  test('the stop comes before the clear: a note that the review sends while the off runs is dropped', async ($, on: ClockStubs) => {
    // The note arrives inside the off's own `$.state` write of the on flag, after the held notes were cleared.
    const acks: ToolCallResult[] = [];
    on('state.set', { key: 'on' }, async (_$, e, next) => {
      if (e.key === 'on' && !e.value.isOn) {
        acks.push(await note($, 'the migration deletes the users table'));
      }
      return next(e);
    });
    const seen = stubDelivery(on);
    stubState(on);
    await startReview($);
    await $.command.run(typed('off'));

    expect(acks).toEqual([{ result: DROPPED }]);
    expect(seen.logs.filter((row) => row.includes('the migration deletes'))).toEqual([]);
  });
});

describe('§7.8, §11.2 a review of a subagent', () => {
  test('a subagent step that spawned the review starts its timer; the timeout puts the batch back in the subagent backlog', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    const state = stubState(on);
    await startSubagentReview($);
    expect(reviews(seen)).toHaveLength(1);

    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(records(state.logWrites)).toEqual([
      { kind: 'timeout', watchdog: 'default', agentId: REVIEW_AGENT, time: NOW + REVIEW_TIMEOUT_MS },
    ]);
    expect(await status($)).toContain('default idle · fail 1/3');

    await subagentEnd($);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toMatch(/subagent Explore[\s\S]*Searching for the token parser\.[\s\S]*Found it/u);
  });

  test('a timed-out subagent review that steered a note moves the cursor of the subagent backlog', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    stubState(on);
    await startSubagentReview($);
    await sendNote($, 'concern', 'parseToken ignores the expiry claim.');
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    await subagentEnd($);

    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).not.toMatch(/Searching for the token parser\./u);
    expect(reviews(seen)[1]).toMatch(/subagent Explore[\s\S]*Found it/u);
  });

  test('`/watchdog off` stops it with reason `off` and counts no failure', async ($, on: ClockStubs) => {
    const stopsAtTaskStop: unknown[] = [];
    const seen = stubDelivery(on, {
      files: EXPLORE_ON,
      onTaskStop: () => stopsAtTaskStop.push(state.reviewsWrites.at(-1)),
    });
    const state = stubState(on);
    await startSubagentReview($);
    await $.command.run(typed('off'));

    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(stopsAtTaskStop).toEqual([{ running: [], stops: [{ agentId: REVIEW_AGENT, reason: 'off' }] }]);
    expect(await note($, 'parseToken ignores the expiry claim.')).toEqual({ result: DROPPED });
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);

    await $.command.run(typed('on'));
    expect(await status($)).toContain('default idle');
    expect(state.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 0, refused: 0 } },
      lastError: null,
    });
  });

  test('a review that a subagent boundary spawns while the off stops the first one stops too', async ($, on: ClockStubs) => {
    // The subagent's next boundary comes inside the off's first `$.state` write of the stop map.
    const window = { isOpen: true };
    on('state.set', { key: 'reviews' }, async (_$, e, next) => {
      if (window.isOpen && e.key === 'reviews' && e.value.stops.length > 0) {
        window.isOpen = false;
        await subagentEnd($);
      }
      return next(e);
    });
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    stubState(on);
    await startSubagentReview($);
    await $.command.run(typed('off'));
    expect(reviews(seen)).toHaveLength(2);

    await $.command.run(typed('on'));
    expect(await status($)).toContain('default idle');
  });
});
