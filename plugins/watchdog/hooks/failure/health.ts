import { HALT_WAITS_MS, MAX_FAILED_REVIEWS } from '../constants';
import { IDLE } from '../review/slots';
import type { Problem, Slot } from '../review/slots';
import type { Backlog } from './backlog';
import type { Outcome } from './classify';

// §12.3: the failed reviews in a row of one watchdog, and its refusals in the session (§12.3 item 10).
export type Counters = { readonly failures: number; readonly refused: number };

export const NO_FAILURES: Counters = { failures: 0, refused: 0 };

// What an outcome does to a watchdog: its next slot, its counts and its backlog.
export type Step = { readonly slot: Slot; readonly counters: Counters; readonly backlog: Backlog };

// One outcome of a review of a watchdog: the problem a try started from (§12.3 items 2, 3), the counts before,
// the notes the review delivered (§12.3 item 1) and the time.
export type StepInput = {
  readonly from: Problem | undefined;
  readonly counters: Counters;
  readonly outcome: Outcome;
  readonly notes: number;
  readonly now: number;
};

// §12.3 item 2: the wait before the try after `tries` failed tries: 5 min, 15 min, then 60 min each time.
const haltWait = (tries: number): number => HALT_WAITS_MS[Math.min(tries, HALT_WAITS_MS.length - 1)] ?? 0;

// §12.3 item 1: a failed review that delivered a note keeps it and moves the cursor; else its batch waits.
const requeue = (input: StepInput): Backlog => (input.notes > 0 ? 'move' : 'keep');

// §12.3 items 1, 2: `count` failures (all of them for billing). A failed try of a halt waits longer; the
// failure that reaches the limit halts the watchdog and drops its backlog.
const failure = (input: StepInput, count: number, backlog: Backlog): Step => {
  const failures = Math.min(input.counters.failures + count, MAX_FAILED_REVIEWS);
  const counters = { ...input.counters, failures };
  const reason = input.outcome.error ?? '';
  if (input.from?.state === 'halted') {
    const tries = input.from.tries + 1;
    return { slot: { state: 'halted', reason, tries, nextTryAt: input.now + haltWait(tries) }, counters, backlog };
  }
  if (failures < MAX_FAILED_REVIEWS) {
    return { slot: IDLE, counters, backlog };
  }
  return { slot: { state: 'halted', reason, tries: 0, nextTryAt: input.now + haltWait(0) }, counters, backlog: 'drop' };
};

// §12.3 items 4, 7, 10: no failure and no success: the notes stay, the cursor moves, a try keeps its state.
const neutral = (input: StepInput, counters: Counters): Step => ({
  slot: input.from ?? IDLE,
  counters,
  backlog: 'move',
});

const STEPS: Readonly<Record<Outcome['kind'], (input: StepInput) => Step>> = {
  answered: (input) => ({ slot: IDLE, counters: { ...input.counters, failures: 0 }, backlog: 'move' }),
  refused: (input) => neutral(input, { ...input.counters, refused: input.counters.refused + 1 }),
  stopped: (input) => neutral(input, input.counters),
  kept: (input) => neutral(input, input.counters),
  // §12.3 item 4: the same batch goes again at once, compact; the caller spawns it.
  retry: (input) => ({ slot: IDLE, counters: input.counters, backlog: 'keep' }),
  // §12.2: a spawn cap counts nothing; the batch waits for the next boundary.
  capped: (input) => ({ slot: input.from ?? IDLE, counters: input.counters, backlog: 'keep' }),
  failed: (input) => failure(input, 1, requeue(input)),
  dropped: (input) => failure(input, 1, 'move'),
  halt: (input) => failure(input, MAX_FAILED_REVIEWS, requeue(input)),
  // §12.3 item 3: a limit counts nothing toward the halt and keeps the backlog.
  limited: (input) => ({
    slot: { state: 'limited', reason: input.outcome.error ?? '' },
    counters: input.counters,
    backlog: requeue(input),
  }),
  // §12.3 item 6: no automatic retry; only `/watchdog on` starts the feed of the watchdog again.
  no_model: (input) => ({
    slot: { state: 'no_model', reason: input.outcome.error ?? '' },
    counters: input.counters,
    backlog: 'forget',
  }),
  blocked: (input) => ({
    slot: { state: 'blocked', reason: input.outcome.error ?? '' },
    counters: input.counters,
    backlog: 'forget',
  }),
};

// §12.3: the state machine of one watchdog.
export const afterOutcome = (input: StepInput): Step => STEPS[input.outcome.kind](input);

// §12.3 items 2, 3: the problem whose one try is due at a person prompt: `limited`, or `halted` once its
// next-try time passed; undefined for every other slot.
export const dueTry = (slot: Slot, now: number): Problem | undefined =>
  slot.state === 'limited' || (slot.state === 'halted' && slot.nextTryAt <= now) ? slot : undefined;
