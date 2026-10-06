import { describe, expect, test } from 'claude-code/testing';
import { NO_BOUNDARY, countBoundary } from '../hooks/review/cadence';
import type { Cadence } from '../hooks/review/cadence';

const STEP = false;
const TURN_END = true;

// The boundaries in order; returns whether a review is due after each one, as when each due review runs at once.
const dueAfter = (setting: { reviewMode: 'turn' | 'agent-end'; reviewInterval: number }, ends: boolean[]) =>
  ends.reduce<{ cadence: Cadence; due: boolean[] }>(
    ({ cadence, due }, isTurnEnd) => {
      const next = countBoundary(cadence, setting, isTurnEnd);
      return { cadence: { ...next, isDue: false }, due: [...due, next.isDue] };
    },
    { cadence: NO_BOUNDARY, due: [] }
  ).due;

describe('review cadence (§7.4)', () => {
  test('turn with interval 1 reviews at each boundary', () => {
    expect(dueAfter({ reviewMode: 'turn', reviewInterval: 1 }, [STEP, STEP, TURN_END])).toEqual([true, true, true]);
  });

  test('agent-end reviews only at the end of the turn', () => {
    expect(dueAfter({ reviewMode: 'agent-end', reviewInterval: 1 }, [STEP, STEP, TURN_END, STEP, TURN_END])).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  test('interval N reviews every Nth eligible update', () => {
    expect(dueAfter({ reviewMode: 'turn', reviewInterval: 3 }, [STEP, STEP, TURN_END, STEP, STEP, TURN_END])).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(
      dueAfter({ reviewMode: 'agent-end', reviewInterval: 2 }, [STEP, TURN_END, STEP, TURN_END, TURN_END, TURN_END])
    ).toEqual([false, false, false, true, false, true]);
  });

  test('a due review that has not run yet stays due at the next boundaries', () => {
    const setting = { reviewMode: 'turn', reviewInterval: 2 } as const;
    const due = countBoundary(countBoundary(NO_BOUNDARY, setting, STEP), setting, STEP);
    expect(countBoundary(due, setting, STEP).isDue).toBe(true);
  });
});
