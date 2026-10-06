import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_TIMEOUT_MS } from '../hooks/constants';
import { NO_FAILURES, afterOutcome } from '../hooks/failure/health';
import {
  NO_REVIEWS,
  TIMEOUT_ERROR,
  dueReviews,
  slotOfClock,
  stopReasonOf,
  stopAll,
  timeLeft,
  timeOut,
  trackReviews,
} from '../hooks/stop/reviews';
import type { Slot } from '../hooks/review/slots';
import type { Reviews } from '../hooks/stop/reviews';

const SPAWNED = 1_000_000;

const reviewing = (agentId: string | null, from?: Extract<Slot, { reason: string }>): Slot => ({
  state: 'reviewing',
  agentId,
  batchEnd: 'a1',
  ...(from === undefined ? {} : { from }),
});

// The default watchdog's review of agent a1, tracked at its spawn.
const tracked = (slot: Slot = reviewing('a1')): Reviews =>
  trackReviews(NO_REVIEWS, [['default', slot]], SPAWNED).reviews;

describe('§7.8 the reviews that run', () => {
  test('a review starts at its spawn, learns its agent later, and ends when its slot leaves `reviewing`', () => {
    const started = trackReviews(NO_REVIEWS, [['default', reviewing(null)]], SPAWNED);
    expect(started).toEqual({
      reviews: { running: [{ watchdog: 'default', agentId: null, spawnedAt: SPAWNED, batchEnd: 'a1' }], stops: [] },
      started: ['default'],
      ended: [],
    });

    const learned = trackReviews(started.reviews, [['default', reviewing('a1')]], SPAWNED + 5);
    expect(learned).toEqual({
      reviews: { running: [{ watchdog: 'default', agentId: 'a1', spawnedAt: SPAWNED, batchEnd: 'a1' }], stops: [] },
      started: [],
      ended: [],
    });

    expect(trackReviews(learned.reviews, [['default', { state: 'idle' }]], SPAWNED + 9)).toEqual({
      reviews: NO_REVIEWS,
      started: [],
      ended: ['default'],
    });
  });

  test('a review that ends and the next one that spawns in one hook end the old one and start the new one', () => {
    expect(trackReviews(tracked(), [['default', reviewing(null)]], SPAWNED + 7)).toEqual({
      reviews: {
        running: [{ watchdog: 'default', agentId: null, spawnedAt: SPAWNED + 7, batchEnd: 'a1' }],
        stops: [],
      },
      started: ['default'],
      ended: ['default'],
    });
  });

  test('a review is due once 10 min passed since its spawn', () => {
    expect(dueReviews(tracked(), SPAWNED + REVIEW_TIMEOUT_MS - 1)).toEqual([]);
    expect(dueReviews(tracked(), SPAWNED + REVIEW_TIMEOUT_MS)).toEqual(['default']);
  });
});

describe('§14.6 the reviews that run at load', () => {
  test('a review gets its slot back as its clock kept it, and its timer the time left', () => {
    const slot: Slot = {
      state: 'reviewing',
      agentId: 'a1',
      batchEnd: 'a1',
      subagent: 'asub0001',
      from: { state: 'limited', reason: 'rate limit' },
      isCompact: true,
    };
    const [clock] = trackReviews(NO_REVIEWS, [['default', slot]], SPAWNED).reviews.running;
    expect(clock === undefined ? undefined : slotOfClock(clock)).toEqual(slot);
    expect(clock === undefined ? undefined : timeLeft(clock, SPAWNED + 1000)).toBe(REVIEW_TIMEOUT_MS - 1000);
    expect(clock === undefined ? undefined : timeLeft(clock, SPAWNED + REVIEW_TIMEOUT_MS + 5)).toBe(0);
  });
});

describe('§7.8 the timeout actions', () => {
  test('the stop map gets `timeout` for the agent, the review leaves the running list, and 1 failure counts', () => {
    expect(timeOut(tracked(), 'default', reviewing('a1'))).toEqual({
      reviews: { running: [], stops: [{ agentId: 'a1', reason: 'timeout' }] },
      stop: 'a1',
      outcome: { kind: 'failed', error: TIMEOUT_ERROR },
    });
    expect(stopReasonOf(timeOut(tracked(), 'default', reviewing('a1'))?.reviews ?? NO_REVIEWS, 'a1')).toBe('timeout');
  });

  test('they run once: a review that already timed out is no longer due and times out no more', () => {
    const first = timeOut(tracked(), 'default', reviewing('a1'));
    expect(dueReviews(first?.reviews ?? NO_REVIEWS, SPAWNED + REVIEW_TIMEOUT_MS)).toEqual([]);
    expect(timeOut(first?.reviews ?? NO_REVIEWS, 'default', reviewing('a1'))).toBeUndefined();
  });

  test('a review whose id never came has nothing to stop, and still counts its failure', () => {
    expect(timeOut(tracked(reviewing(null)), 'default', reviewing(null))).toEqual({
      reviews: NO_REVIEWS,
      stop: null,
      outcome: { kind: 'failed', error: TIMEOUT_ERROR },
    });
  });

  test('the outcome keeps the notes and moves the cursor, or puts a batch with no notes back; the slot is free', () => {
    const outcome = timeOut(tracked(), 'default', reviewing('a1'))?.outcome ?? { kind: 'answered', error: null };
    const input = { from: undefined, counters: NO_FAILURES, outcome, now: SPAWNED };
    expect(afterOutcome({ ...input, notes: 2 })).toEqual({
      slot: { state: 'idle' },
      counters: { failures: 1, refused: 0 },
      backlog: 'move',
    });
    expect(afterOutcome({ ...input, notes: 0 }).backlog).toBe('keep');
  });
});

describe('§5.2, §7.8 a stop for `off`, `session` or `rewind`', () => {
  test('each review that runs stops with the reason; its slot is free with no failure, a try goes back to its problem', () => {
    const halted = { state: 'halted', reason: 'x', tries: 1, nextTryAt: 5 } as const;
    const running = trackReviews(
      NO_REVIEWS,
      [
        ['default', reviewing('a1')],
        ['security', reviewing('a2', halted)],
        ['style', reviewing(null)],
      ],
      SPAWNED
    ).reviews;
    const slots: Readonly<Record<string, Slot>> = {
      default: reviewing('a1'),
      security: reviewing('a2', halted),
      style: reviewing(null),
    };
    expect(stopAll(running, (slug) => slots[slug] ?? { state: 'idle' }, 'off')).toEqual({
      reviews: {
        running: [],
        stops: [
          { agentId: 'a1', reason: 'off' },
          { agentId: 'a2', reason: 'off' },
        ],
      },
      stops: ['a1', 'a2'],
      freed: [
        ['default', { state: 'idle' }],
        ['security', halted],
        ['style', { state: 'idle' }],
      ],
    });
  });

  test('an agent that no stop names has no reason: the person stopped it (§12.3 item 7)', () => {
    expect(stopReasonOf(NO_REVIEWS, 'a1')).toBeUndefined();
  });
});
