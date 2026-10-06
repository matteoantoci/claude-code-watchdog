import { REVIEW_TIMEOUT_MS } from '../constants';
import { IDLE } from '../review/slots';
import type { Outcome } from '../failure/classify';
import type { Slot } from '../review/slots';
import type { PluginState } from 'claude-code';

// §7.8, §14.1: the reviews that run and the stop map (the `reviews` key of the state contract).
export type Reviews = PluginState['watchdog']['reviews'];

// One review that runs: its watchdog slug, its agent and its spawn time.
export type ReviewClock = Reviews['running'][number];

export type StopReason = Reviews['stops'][number]['reason'];

export const NO_REVIEWS: Reviews = { running: [], stops: [] };

// §7.8, §12.4: the error of a timeout, for `last error`.
export const TIMEOUT_ERROR = 'the review ran for more than 10 min';

const agentOf = (slot: Slot): string | null => (slot.state === 'reviewing' ? slot.agentId : null);

const slotIn = (slots: readonly (readonly [string, Slot])[], slug: string): Slot =>
  slots.find(([known]) => known === slug)?.[1] ?? IDLE;

// The slot still runs the review of this clock: it is `reviewing`, and its agent is the clock's or the clock
// had none yet (the id comes after the spawn, §16.2).
const isSameReview = (clock: ReviewClock, slot: Slot): boolean =>
  slot.state === 'reviewing' && (clock.agentId === null || clock.agentId === slot.agentId);

// §7.8: the reviews that run, from the slots of each watchdog now. A slot that is `reviewing` with no clock
// started a review now; a clock whose slot left `reviewing`, or runs another agent, ended. A review that
// ends and the next that spawns in one hook do both. Returns the slugs whose timer starts and ends.
export const trackReviews = (
  reviews: Reviews,
  slots: readonly (readonly [string, Slot])[],
  now: number
): { reviews: Reviews; started: string[]; ended: string[] } => {
  const kept = reviews.running.filter((clock) => isSameReview(clock, slotIn(slots, clock.watchdog)));
  const ended = reviews.running.filter((clock) => !kept.includes(clock)).map((clock) => clock.watchdog);
  const started = slots
    .filter(([slug, slot]) => slot.state === 'reviewing' && !kept.some((clock) => clock.watchdog === slug))
    .map(([slug]) => slug);
  const running = [
    ...kept.map(({ watchdog, spawnedAt }) => ({ watchdog, agentId: agentOf(slotIn(slots, watchdog)), spawnedAt })),
    ...started.map((slug) => ({ watchdog: slug, agentId: agentOf(slotIn(slots, slug)), spawnedAt: now })),
  ];
  return { reviews: { ...reviews, running }, started, ended };
};

// §7.8: the fallback check: the watchdogs whose review runs for 10 min or more.
export const dueReviews = (reviews: Reviews, now: number): string[] =>
  reviews.running.filter((clock) => now - clock.spawnedAt >= REVIEW_TIMEOUT_MS).map((clock) => clock.watchdog);

const withStops = (reviews: Reviews, agentIds: readonly string[], reason: StopReason): Reviews['stops'] => [
  ...reviews.stops,
  ...agentIds.map((agentId) => ({ agentId, reason })),
];

// §7.8: the timeout actions of the watchdog's review, once: the review leaves the running list, the stop map
// gets `timeout` for its agent (written before the `TaskStop` of `stop`; null when its id never came), and the
// outcome counts 1 failure, which keeps the notes or puts the batch back and frees the slot (§12.3).
// Undefined when no review of the watchdog runs.
export const timeOut = (
  reviews: Reviews,
  slug: string,
  slot: Slot
): { reviews: Reviews; stop: string | null; outcome: Outcome } | undefined => {
  const clock = reviews.running.find((known) => known.watchdog === slug);
  if (clock === undefined || slot.state !== 'reviewing') {
    return undefined;
  }
  const stop = slot.agentId;
  const running = reviews.running.filter((known) => known !== clock);
  return {
    reviews: { running, stops: withStops(reviews, stop === null ? [] : [stop], 'timeout') },
    stop,
    outcome: { kind: 'failed', error: TIMEOUT_ERROR },
  };
};

// §5.2, §7.8: a stop for `off`, `session` or `rewind` stops each review that runs, with no failure: the stop
// map names each agent, and each slot goes free (a try goes back to the problem it started from). Returns the
// agents to stop and the freed slots.
export const stopAll = (
  reviews: Reviews,
  slotOf: (slug: string) => Slot,
  reason: StopReason
): { reviews: Reviews; stops: string[]; freed: (readonly [string, Slot])[] } => {
  const slots = reviews.running.map((clock) => [clock.watchdog, slotOf(clock.watchdog)] as const);
  const freed = slots.flatMap(([slug, slot]) =>
    slot.state === 'reviewing' ? [[slug, slot.from ?? IDLE] as const] : []
  );
  const stops = slots.flatMap(([, slot]) =>
    slot.state === 'reviewing' && slot.agentId !== null ? [slot.agentId] : []
  );
  return { reviews: { running: [], stops: withStops(reviews, stops, reason) }, stops, freed };
};

// §7.8: the reason the mod stopped this agent; undefined for an agent it did not stop.
export const stopReasonOf = (reviews: Reviews, agentId: string): StopReason | undefined =>
  reviews.stops.find((stop) => stop.agentId === agentId)?.reason;

// The live copy is module memory; `$.state` key `reviews` keeps a copy (§14.1).
const memory: { reviews: Reviews } = { reviews: NO_REVIEWS };

export const currentReviews = (): Reviews => memory.reviews;

export const setReviews = (reviews: Reviews): void => {
  memory.reviews = reviews;
};
