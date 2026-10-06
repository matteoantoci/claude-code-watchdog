import { MAX_FAILED_REVIEWS } from '../constants';
import { currentFeed, setFeed } from '../feed/feed';
import { traceError, traceOf } from '../log/log';
import { setSlot, slotOf } from '../review/slots';
import { applyBacklog } from './backlog';
import { reviewOutcome } from './classify';
import { NO_FAILURES, afterOutcome } from './health';
import type { Watchdog } from '../agents/roster';
import type { Problem, RunningReview, Slot } from '../review/slots';
import type { Outcome } from './classify';
import type { Counters } from './health';
import type { PluginState, TurnCompleteInput } from 'claude-code';

// §12.3, §14.1: the failure state of every watchdog (its shape is the `health` key of the state contract).
export type Health = PluginState['watchdog']['health'];

// Module memory; `$.state` key `health` keeps the counts, the problems and the last error (§12.3). `shown`
// is the problem state of the last §12.5 row of each slug, `saved` the JSON of the last `health` write.
// `errors` and `models` hold, for each review agent, the text of its last synthetic row (§12.1) and the
// model of its spawn (§12.2).
const memory: {
  counters: Map<string, Counters>;
  shown: Map<string, Problem['state']>;
  lastError: string | null;
  saved: string;
  errors: Map<string, string>;
  models: Map<string, string>;
} = { counters: new Map(), shown: new Map(), lastError: null, saved: '', errors: new Map(), models: new Map() };

const countersOf = (slug: string): Counters => memory.counters.get(slug) ?? NO_FAILURES;

// §12.4: the problem of a slot; a try shows the problem it started from.
export const problemOf = (slot: Slot): Problem | undefined => {
  if (slot.state === 'reviewing') {
    return slot.from;
  }
  return 'reason' in slot ? slot : undefined;
};

// §12.1: the agent's synthetic row holds the error text; the retries add rows with no text.
export const rememberErrorText = (agentId: string, text: string): void => {
  if (text !== '') {
    memory.errors.set(agentId, text);
  }
};

// §12.2: the model of the `agent.spawn` hook's `next(e)` result, read when the end has no `usage.model`.
export const rememberSpawnModel = (agentId: string, model: string): void => {
  memory.models.set(agentId, model);
};

// §12.4: each error goes to `last error` in the status.
export const setLastError = (watchdog: string, error: string): void => {
  memory.lastError = `${watchdog}: ${error}`;
};

// §12.1 to §12.3: the outcome of a running review's own `turn.complete`, from what the mod saw of its agent:
// the text of its last synthetic row, its step count and the model of its spawn, taken now because the agent
// never runs again. The error goes to the review's record and to `last error`. With the notes the review
// delivered (§12.3 item 1): admitted, and not displaced or dropped since.
export const endOutcome = (e: TurnCompleteInput, review: RunningReview): { outcome: Outcome; notes: number } => {
  const { agentId, slot, watchdog } = review;
  const trace = traceOf(agentId);
  const outcome = reviewOutcome({
    end: e,
    errorText: memory.errors.get(agentId),
    steps: trace.steps,
    isCompact: slot.isCompact === true,
    model: watchdog.model,
    ran: e.usage?.model ?? memory.models.get(agentId),
  });
  memory.errors.delete(agentId);
  memory.models.delete(agentId);
  if (outcome.error !== null) {
    traceError(agentId, outcome.error);
    setLastError(watchdog.name, outcome.error);
  }
  const notes = trace.notes.filter((note) => note.delivery !== 'displaced' && !note.delivery.startsWith('dropped:'));
  return { outcome, notes: notes.length };
};

// §7.5, §12.3: one outcome of a review (or of its spawn) moves its watchdog's slot, counts and backlog.
export const applyOutcome = (
  slug: string,
  outcome: Outcome,
  review: { from: Problem | undefined; notes: number; now: number; batchEnd: string }
): void => {
  const step = afterOutcome({ ...review, counters: countersOf(slug), outcome });
  setSlot(slug, step.slot);
  memory.counters.set(slug, step.counters);
  setFeed(applyBacklog(currentFeed(), { slug, batchEnd: review.batchEnd }, step.backlog));
};

// §12.3 item 2: `/watchdog on` tries at once: the failure counts go, and a running try forgets its problem.
export const resetFailures = (watchdogs: readonly Watchdog[]): void => {
  watchdogs.forEach(({ slug }) => {
    memory.counters.set(slug, { ...countersOf(slug), failures: 0 });
    const slot = slotOf(slug);
    if (slot.state === 'reviewing') {
      setSlot(slug, { ...slot, from: undefined });
    }
  });
};

// §12.5: one row when a watchdog goes into a problem state, with its error text, and one row when it leaves it
// for `idle` or a review. A change of the error text alone writes no row.
export const stateRows = (watchdogs: readonly Watchdog[]): string[] =>
  watchdogs.flatMap(({ name, slug }) => {
    const slot = slotOf(slug);
    const problem = problemOf(slot);
    const shown = memory.shown.get(slug);
    if (problem?.state === shown) {
      return [];
    }
    if (problem !== undefined) {
      memory.shown.set(slug, problem.state);
      return [`watchdog: ${name} ${problem.state}: ${problem.reason}`];
    }
    memory.shown.delete(slug);
    return slot.state === 'disabled' ? [] : [`watchdog: ${name} is back`];
  });

// §12.3, §14.1: the value of the `health` key when it changed since the last write, else undefined.
export const changedHealth = (watchdogs: readonly Watchdog[]): Health | undefined => {
  const health: Health = {
    watchdogs: Object.fromEntries(
      watchdogs.map(({ slug }) => [slug, { problem: problemOf(slotOf(slug)) ?? null, ...countersOf(slug) }])
    ),
    lastError: memory.lastError,
  };
  const json = JSON.stringify(health);
  if (json === memory.saved) {
    return undefined;
  }
  memory.saved = json;
  return health;
};

// §12.3: at module load the stored counts and problems come back, the halt with its next-try time. A problem
// that the load's own `/watchdog on` found wins; a stored `no_model` or `blocked` leaves the feed again. The
// rows of the stored problems were shown before the load.
export const restoreHealth = (health: Health, watchdogs: readonly Watchdog[]): void => {
  memory.lastError = health.lastError;
  memory.saved = JSON.stringify(health);
  watchdogs.forEach(({ slug }) => {
    const stored = health.watchdogs[slug];
    const problem = stored?.problem ?? null;
    memory.counters.set(
      slug,
      stored === undefined ? NO_FAILURES : { failures: stored.failures, refused: stored.refused }
    );
    if (problem === null) {
      return;
    }
    memory.shown.set(slug, problem.state);
    if (slotOf(slug).state !== 'idle') {
      return;
    }
    setSlot(slug, problem);
    if (problem.state === 'no_model' || problem.state === 'blocked') {
      setFeed(applyBacklog(currentFeed(), { slug, batchEnd: '' }, 'forget'));
    }
  });
};

const clockTime = (time: number): string => new Date(time).toISOString().replace(/^.*T(\d\d:\d\d).*$/u, '$1 UTC');

// §12.4, §13.3: the parts the status line of a watchdog adds after its state: the next try of a halt,
// `fail N/3` after 1 or 2 failures, and the refusals.
export const healthParts = (slug: string): string[] => {
  const slot = slotOf(slug);
  const { failures, refused } = countersOf(slug);
  return [
    ...(slot.state === 'halted' ? [`retry after ${clockTime(slot.nextTryAt)}`] : []),
    ...(failures > 0 && problemOf(slot) === undefined ? [`fail ${failures}/${MAX_FAILED_REVIEWS}`] : []),
    ...(refused > 0 ? [`refused ${refused}`] : []),
  ];
};

// §12.4, §13.3: the last error of any watchdog.
export const lastErrorLines = (): string[] => (memory.lastError === null ? [] : [`last error: ${memory.lastError}`]);
