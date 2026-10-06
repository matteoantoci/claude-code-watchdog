import { describe, expect, test } from 'claude-code/testing';
import { NO_FAILURES, afterOutcome, dueTry } from '../hooks/failure/health';
import type { Outcome } from '../hooks/failure/classify';
import type { Counters } from '../hooks/failure/health';
import type { Problem } from '../hooks/review/slots';

const NOW = Date.UTC(2026, 9, 6, 9, 5, 3);
const MINUTE = 60_000;
const OVERLOAD = 'API Error: 529 Overloaded.';

const failed: Outcome = { kind: 'failed', error: OVERLOAD };

type Input = { from?: Problem; counters?: Counters; notes?: number; now?: number };

const after = (outcome: Outcome, input: Input = {}) =>
  afterOutcome({
    from: input.from,
    counters: input.counters ?? NO_FAILURES,
    outcome,
    notes: input.notes ?? 0,
    now: input.now ?? NOW,
  });

// Three failed reviews in a row, from a fresh watchdog.
const threeFailures = () => {
  const first = after(failed);
  const second = after(failed, { counters: first.counters });
  return { first, second, third: after(failed, { counters: second.counters }) };
};

describe('§12.3 item 1: no retries by the mod, requeue', () => {
  test('a failed review with no notes counts 1 and puts its batch back', () => {
    expect(after(failed)).toEqual({ slot: { state: 'idle' }, counters: { failures: 1, refused: 0 }, backlog: 'keep' });
  });

  test('a failed review that delivered a note keeps it and moves the cursor', () => {
    expect(after(failed, { notes: 1 }).backlog).toBe('move');
  });

  test('a success moves the cursor and resets the count', () => {
    expect(after({ kind: 'answered', error: null }, { counters: { failures: 2, refused: 1 } })).toEqual({
      slot: { state: 'idle' },
      counters: { failures: 0, refused: 1 },
      backlog: 'move',
    });
  });
});

describe('§12.3 item 2: halt', () => {
  test('the 3rd failed review in a row halts the watchdog, drops its backlog and waits 5 min', () => {
    const { first, second, third } = threeFailures();
    expect([first.counters.failures, second.counters.failures]).toEqual([1, 2]);
    expect(third).toEqual({
      slot: { state: 'halted', reason: OVERLOAD, tries: 0, nextTryAt: NOW + 5 * MINUTE },
      counters: { failures: 3, refused: 0 },
      backlog: 'drop',
    });
  });

  test('billing halts at the first failure', () => {
    const step = after({ kind: 'halt', error: 'Credit balance is too low' });
    expect(step.slot).toEqual({
      state: 'halted',
      reason: 'Credit balance is too low',
      tries: 0,
      nextTryAt: NOW + 5 * MINUTE,
    });
    expect(step.backlog).toBe('drop');
  });

  test('a failed try waits 15 min, then 60 min each time, and keeps the updates for the next try', () => {
    const halted = threeFailures().third;
    const later = NOW + 6 * MINUTE;
    const second = after(failed, { from: halted.slot as Problem, counters: halted.counters, now: later });
    expect(second.slot).toEqual({ state: 'halted', reason: OVERLOAD, tries: 1, nextTryAt: later + 15 * MINUTE });
    expect(second.backlog).toBe('keep');
    const third = after(failed, { from: second.slot as Problem, counters: second.counters, now: later });
    expect(third.slot).toMatchObject({ tries: 2, nextTryAt: later + 60 * MINUTE });
    const fourth = after(failed, { from: third.slot as Problem, counters: third.counters, now: later });
    expect(fourth.slot).toMatchObject({ tries: 3, nextTryAt: later + 60 * MINUTE });
    expect(fourth.counters.failures).toBe(3);
  });

  test('a successful try ends the halt and resets the count and the waits', () => {
    const halted = threeFailures().third;
    const back = after({ kind: 'answered', error: null }, { from: halted.slot as Problem, counters: halted.counters });
    expect(back).toEqual({ slot: { state: 'idle' }, counters: { failures: 0, refused: 0 }, backlog: 'move' });
  });

  test('the try waits for the first person prompt after the next-try time', () => {
    const { slot } = threeFailures().third;
    expect(dueTry(slot, NOW + 5 * MINUTE - 1)).toBeUndefined();
    expect(dueTry(slot, NOW + 5 * MINUTE)).toEqual(slot);
    expect(dueTry({ state: 'idle' }, NOW)).toBeUndefined();
  });
});

describe('§12.3 items 3 to 7, 10', () => {
  test('a subscription limit gives limited, counts nothing, keeps the backlog and tries at the next person prompt', () => {
    const step = after({ kind: 'limited', error: "You've hit your limit" }, { counters: { failures: 2, refused: 0 } });
    expect(step).toEqual({
      slot: { state: 'limited', reason: "You've hit your limit" },
      counters: { failures: 2, refused: 0 },
      backlog: 'keep',
    });
    expect(dueTry(step.slot, NOW)).toEqual(step.slot);
  });

  test('a prompt too large at step 0 retries the same batch; still too large drops it and counts 1', () => {
    expect(after({ kind: 'retry', error: 'Prompt is too long' })).toEqual({
      slot: { state: 'idle' },
      counters: NO_FAILURES,
      backlog: 'keep',
    });
    expect(after({ kind: 'dropped', error: 'Prompt is too long' })).toEqual({
      slot: { state: 'idle' },
      counters: { failures: 1, refused: 0 },
      backlog: 'move',
    });
  });

  test('a prompt too large at a later step, a person stop and a refusal move the cursor and count no failure', () => {
    const counters = { failures: 1, refused: 0 };
    expect(after({ kind: 'kept', error: 'Prompt is too long' }, { counters })).toEqual({
      slot: { state: 'idle' },
      counters,
      backlog: 'move',
    });
    expect(after({ kind: 'stopped', error: null }, { counters }).counters).toEqual(counters);
    expect(after({ kind: 'refused', error: null }, { counters })).toEqual({
      slot: { state: 'idle' },
      counters: { failures: 1, refused: 1 },
      backlog: 'move',
    });
  });

  test('no_model and blocked stop the reviews of the watchdog with no automatic retry', () => {
    for (const kind of ['no_model', 'blocked'] as const) {
      const step = after({ kind, error: 'why' });
      expect(step).toEqual({ slot: { state: kind, reason: 'why' }, counters: NO_FAILURES, backlog: 'forget' });
      expect(dueTry(step.slot, NOW + 600 * MINUTE)).toBeUndefined();
    }
  });

  test('a spawn cap leaves the batch in the backlog and counts no failure', () => {
    expect(after({ kind: 'capped', error: 'Concurrent subagent limit reached.' })).toEqual({
      slot: { state: 'idle' },
      counters: NO_FAILURES,
      backlog: 'keep',
    });
  });

  test('a try that ends with no failure and no success leaves its state as it was', () => {
    const limited: Problem = { state: 'limited', reason: "You've hit your limit" };
    expect(after({ kind: 'stopped', error: null }, { from: limited }).slot).toEqual(limited);
    expect(after({ kind: 'capped', error: 'cap' }, { from: limited }).slot).toEqual(limited);
  });
});
