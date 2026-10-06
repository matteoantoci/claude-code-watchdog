import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_TIMEOUT_MS } from '../hooks/constants';
import { REVIEW_SPAWN, stubDelivery } from './fixtures/delivery';
import { stubState } from './fixtures/on-state';
import { NOW, REVIEW_AGENT, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { SessionStubs } from './fixtures/session';
import type { SessionAppendInput, ToolCallResult } from 'claude-code';
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

// The review prompts the mod spawned (the test's own `REVIEW_SPAWN` reaches the stub too).
const reviews = (seen: { spawns: readonly { prompt: string }[] }): string[] =>
  seen.spawns.map((spawn) => spawn.prompt).filter((prompt) => prompt !== REVIEW_SPAWN.prompt);

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

  test('a later note of the timed-out agent is dropped, and its aborted end only logs its usage', async ($, on: ClockStubs) => {
    const seen = stubDelivery(on);
    const state = stubState(on);
    await startReview($);
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    const logs = seen.logs.length;

    expect(await note($, 'parseDate drops the timezone')).toEqual({ result: DROPPED });
    await abortedEnd($);

    expect(seen.logs.slice(logs)).toEqual([]);
    expect(await status($)).toContain('default idle · fail 1/3');
    expect(records(state.logWrites)).toContainEqual(
      expect.objectContaining({ kind: 'review', agentId: REVIEW_AGENT, reason: 'aborted', notes: [] })
    );
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
    await seen.clock.advance(REVIEW_TIMEOUT_MS);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);

    await $.command.run(typed('on'));
    expect(await status($)).toContain('default idle');
    expect(state.healthWrites.at(-1)).toEqual({
      watchdogs: { default: { problem: null, failures: 0, refused: 0 } },
      lastError: null,
    });
  });
});
