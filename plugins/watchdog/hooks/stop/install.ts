import { watchdogOf } from '../agents/ids';
import { currentRoster, watchdogBySlug } from '../agents/roster';
import { parseSubcommand } from '../command/args';
import { REVIEW_TIMEOUT_MS } from '../constants';
import { errorText } from '../errors';
import { applyOutcome, changedHealth, deliveredNotes, setLastError, stateRows } from '../failure/state';
import { currentFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { addLogRecord, currentLog, errorRecord, timeoutRecord } from '../log/log';
import { addNoteGuard } from '../note/notes';
import { setSlot, slotOf } from '../review/slots';
import {
  TIMEOUT_ERROR,
  currentReviews,
  dueReviews,
  setReviews,
  stopAll,
  stopReasonOf,
  timeOut,
  trackReviews,
} from './reviews';
import type { OnEvents } from '../on';
import type { StopReason } from './reviews';
import type { EngineInterface, Hook, Timer, ToolCallResult } from 'claude-code';

// §9.5: the ack of a note from an agent the mod stopped (§7.8 action 5, §5.2 step 1).
const STOPPED_ACK = 'Dropped: the review was stopped.';

// §7.8: the 10 min timer of each watchdog's review that runs; a reload cancels them with the old instance.
const timers = new Map<string, Timer>();

const nameOf = (slug: string | undefined): string =>
  (slug === undefined ? undefined : watchdogBySlug(slug)?.name) ?? slug ?? 'unknown';

const endTimer = (slug: string): void => {
  timers.get(slug)?.cancel();
  timers.delete(slug);
};

// §14.1: `$.state` keeps a copy of the reviews that run, the stop map, the log and the feed; a refused write
// loses only what a reload would carry over.
const saveReviews = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'reviews' }, currentReviews()).catch(() => undefined);
};

const saveLog = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §12.5, §12.3: a timeout from the timer runs in no hook, so it writes its own rows and `health`; the failure
// area's hooks write nothing more for the same change.
const report = async ($: EngineInterface): Promise<void> => {
  stateRows(currentRoster()).forEach((row) => {
    $.ui.log(row);
  });
  const health = changedHealth(currentRoster());
  if (health !== undefined) {
    await $.state.set({ plugin: 'watchdog', key: 'health' }, health).catch(() => undefined);
  }
};

// The error text of a `TaskStop` that stopped nothing: a deny, or an errored result.
const stopProblem = (result: ToolCallResult): string | undefined => {
  if (result.deny !== undefined) {
    return result.deny;
  }
  return result.isError === true ? (result.text ?? errorText(result.result)) : undefined;
};

// §7.8: stop a review agent; the task id is its `agentId`. A reject goes once to the dump.
const stopAgent = async ($: EngineInterface, agentId: string, time: number): Promise<void> => {
  const problem = await $.tool.call({ tool: 'TaskStop', task_id: agentId }).then(stopProblem, errorText);
  if (problem !== undefined) {
    addLogRecord(errorRecord({ watchdog: nameOf(watchdogOf(agentId)), time, error: `TaskStop failed: ${problem}` }));
  }
};

// §7.8: the 6 timeout actions, once: the stop map entry `timeout`, 1 failure that keeps the notes or puts the
// batch back in the backlog the review took (§11.2) and frees the slot, the record, then `TaskStop` (the slot is
// free also when it rejects). The note guard drops each later note of the agent. All but the writes run before
// the first await, so the timer and the fallback check never both run them, and the agent's aborted end finds no
// review to finish.
const timeOutReview = async ($: EngineInterface, slug: string, now: number): Promise<void> => {
  const slot = slotOf(slug);
  const timed = timeOut(currentReviews(), slug, slot);
  if (timed === undefined || slot.state !== 'reviewing') {
    return;
  }
  endTimer(slug);
  setReviews(timed.reviews);
  const notes = timed.stop === null ? 0 : deliveredNotes(timed.stop);
  const { from, batchEnd, subagent } = slot;
  applyOutcome(slug, timed.outcome, { from, notes, now, batchEnd, subagent });
  setLastError(nameOf(slug), TIMEOUT_ERROR);
  addLogRecord(timeoutRecord({ watchdog: nameOf(slug), agentId: timed.stop, time: now }));
  await saveReviews($);
  if (timed.stop !== null) {
    await stopAgent($, timed.stop, now);
  }
  await saveLog($);
  await report($);
};

// §7.8: the fallback check of the main loop: each review that runs for 10 min or more times out.
const checkTimeouts = async ($: EngineInterface): Promise<void> => {
  if (currentReviews().running.length === 0) {
    return;
  }
  const now = await $.clock.now();
  await Promise.all(dueReviews(currentReviews(), now).map(async (slug) => timeOutReview($, slug, now)));
};

// §7.8: the 10 min timer of a review that starts now.
const startTimer = ($: EngineInterface, slug: string): void => {
  const timer = $.clock.after(REVIEW_TIMEOUT_MS, () => {
    $.clock
      .now()
      .then(async (now) => timeOutReview($, slug, now))
      .catch(() => undefined);
  });
  timers.set(slug, timer);
};

// §7.8: after a hook beneath spawned or ended a review: a new review starts its 10 min timer, an ended one
// cancels it.
const trackAll = async ($: EngineInterface): Promise<void> => {
  const slugs = new Set([
    ...currentRoster().map((watchdog) => watchdog.slug),
    ...currentReviews().running.map((clock) => clock.watchdog),
  ]);
  const slots = Array.from(slugs, (slug) => [slug, slotOf(slug)] as const);
  if (currentReviews().running.length === 0 && slots.every(([, slot]) => slot.state !== 'reviewing')) {
    return;
  }
  const before = JSON.stringify(currentReviews());
  const tracked = trackReviews(currentReviews(), slots, await $.clock.now());
  setReviews(tracked.reviews);
  tracked.ended.forEach(endTimer);
  tracked.started.forEach((slug) => {
    startTimer($, slug);
  });
  if (JSON.stringify(tracked.reviews) !== before) {
    await saveReviews($);
  }
};

// §5.2 step 1, §7.8: stop each review that runs with the reason, with no failure; the stop map entries are
// written before the `TaskStop` calls.
const stopReviews = async ($: EngineInterface, reason: StopReason): Promise<void> => {
  const stopped = stopAll(currentReviews(), slotOf, reason);
  stopped.freed.forEach(([slug, slot]) => {
    setSlot(slug, slot);
    endTimer(slug);
  });
  setReviews(stopped.reviews);
  await saveReviews($);
  if (stopped.stops.length === 0) {
    return;
  }
  const now = await $.clock.now();
  await Promise.all(stopped.stops.map(async (agentId) => stopAgent($, agentId, now)));
  await saveLog($);
};

// §7.8: the fallback check runs at the start of the main-loop step, never in a watchdog agent's own event.
// §11.2: a watched subagent's step may spawn a review, so each step tracks the reviews after it.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined) {
    await checkTimeouts($);
  }
  const response = yield* next(e);
  await trackAll($);
  return response;
};

// §7.8: the fallback check at the start of the main-loop end; any end (a review's own too) may end a review
// and spawn the next.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId === undefined) {
    await checkTimeouts($);
  }
  const result = await next(e);
  await trackAll($);
  return result;
};

// §12.3 items 2, 3: a person prompt may spawn a try.
const onPrompt: Hook<'prompt.submit'> = async ($, e, next) => {
  const result = await next(e);
  await trackAll($);
  return result;
};

// §5.2: `/watchdog off` beneath turned the session off: each review that runs stops with reason `off`.
// `/watchdog on` may disable a watchdog whose review runs.
const onCommand: Hook<'command.run'> = async ($, e, next) => {
  const result = await next(e);
  await (parseSubcommand(e.args) === 'off' && currentMode() === 'off' ? stopReviews($, 'off') : trackAll($));
  return result;
};

// Install after the failure area and before the command and review areas: these hooks sit beneath the
// failure area's, which writes the rows and `health` of a fallback timeout, and above the hooks that spawn
// and end reviews. The matchers only tell these `on()` from the other areas'.
export const installStop = (on: OnEvents<'turn.step' | 'turn.complete' | 'prompt.submit' | 'command.run'>): void => {
  on('turn.step', { turnId: /^/u }, onStep);
  on('turn.complete', { turnId: /^/u }, onComplete);
  on('prompt.submit', { text: /^/u }, onPrompt);
  on('command.run', { command: 'watchdog' }, onCommand);
  addNoteGuard((note) => (stopReasonOf(currentReviews(), note.agentId) === undefined ? undefined : STOPPED_ACK));
};
