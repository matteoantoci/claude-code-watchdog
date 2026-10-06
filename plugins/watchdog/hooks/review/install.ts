import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { registeredSpec, setRegisteredSpec } from '../agents/registered';
import { currentRoster } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { errorText } from '../errors';
import { classifySpawnError } from '../failure/classify';
import { dueTry } from '../failure/health';
import { applyOutcome, endOutcome, setLastError } from '../failure/state';
import { addServerToolUses, closeUpdate, currentFeed, pendingBatch, setFeed, unreviewedCalls } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession } from '../lifecycle/on-order';
import { addLogRecord, currentLog, errorRecord, rememberPrompt, unreviewedRecord } from '../log/log';
import { liveHistory, notesKey, readHistory, watchdogNotes } from '../note/history';
import { isPersonPrompt } from '../person';
import { resolveEffort, sessionEffort, setSessionEffort } from '../roster/model';
import { dropBacklog, isUnboundReject, waitingUpdates } from './backlog';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { reviewPrompt } from './prompt';
import { IDLE, isReady, learnReviewAgent, runningReview, setSlot, slotOf } from './slots';
import { lastErrorStatus, rosterLines, watchdogStatusLines } from './status';
import type { Watchdog } from '../agents/roster';
import type { UpdateClose } from '../feed/feed';
import type { RecapNote } from '../note/history';
import type { OnEvents } from '../on';
import type { ReviewInput } from './prompt';
import type { Problem, Start } from './slots';
import type { EngineInterface, Hook, TurnCompleteInput } from 'claude-code';

// The live copies are module memory; `$.state` keeps them across a reload (§14.1), so a refused write
// loses only that carry-over.
const save = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'ids' }, watchdogIds()).catch(() => undefined);
};

// §7.7 part 1: the watchdog's newest 20 notes of this session: the note area's live copy of
// `notes:<sessionId>`, else the stored value.
const recapNotes = async ($: EngineInterface, slug: string): Promise<readonly RecapNote[]> => {
  const sessionId = await $.session.id();
  const history = liveHistory(sessionId) ?? readHistory(await $.store.get(notesKey(sessionId)));
  return watchdogNotes(history, slug).notes;
};

// §7.7: the recap of one review. Parts 2 and 3 read the main conversation in Messages API form; a refused
// read leaves its parts empty.
const recapOf = async ($: EngineInterface, slug: string): Promise<Omit<ReviewInput, 'updates'>> => {
  const [notes, messages] = await Promise.all([
    recapNotes($, slug).catch(() => []),
    $.session.messages({ as: 'api' }).catch(() => []),
  ]);
  const feed = currentFeed();
  return { notes, messages, prompts: feed.prompts, skip: unreviewedCalls(feed, slug) };
};

// §4.5, §6.2: before each spawn the spec is built again, with the `:auto` effort of now; the guidance area's
// `agent.register` hook adds the context of now and lets only a spec that differs reach the engine. A
// register reject keeps the type as it was (§6.1).
const refreshAgent = async ($: EngineInterface, watchdog: Watchdog): Promise<void> => {
  const registered = registeredSpec(watchdog.slug);
  if (registered === undefined) {
    return;
  }
  const spec = { ...registered, effort: resolveEffort(watchdog.effort, sessionEffort()) };
  await $.agent.register(spec).then(
    () => setRegisteredSpec(spec),
    () => undefined
  );
};

// §7.5: in `-p` a spawn rejects with `no session is bound` once the session unbound. The watchdog's backlog
// goes, with one `unreviewed: N updates` record for the dump file (§10.6); no failure counts. Returns whether
// the backlog went.
const dropUnbound = async ($: EngineInterface, watchdog: Watchdog, reason: string): Promise<boolean> => {
  if (isInteractiveSession() || !isUnboundReject(reason)) {
    return false;
  }
  const updates = waitingUpdates(currentFeed(), currentFeed().cursors[watchdog.slug]);
  setFeed(dropBacklog(currentFeed(), watchdog.slug));
  addLogRecord(unreviewedRecord({ watchdog: watchdog.name, time: await $.clock.now(), updates }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
  return true;
};

// §12.2: a spawn that started no agent gives `blocked`, a cap (no failure; the batch waits for the next
// boundary) or 1 failure; the error goes to `last error` and to the dump. The `-p` unbind is §7.5.
const spawnFailed = async (
  $: EngineInterface,
  watchdog: Watchdog,
  failure: { error: string; from: Problem | undefined; batchEnd: string }
): Promise<void> => {
  setSlot(watchdog.slug, failure.from ?? IDLE);
  if (await dropUnbound($, watchdog, failure.error)) {
    return;
  }
  const time = await $.clock.now();
  const outcome = { kind: classifySpawnError(failure.error), error: failure.error };
  applyOutcome(watchdog.slug, outcome, { from: failure.from, notes: 0, now: time, batchEnd: failure.batchEnd });
  setLastError(watchdog.name, failure.error);
  addLogRecord(errorRecord({ watchdog: watchdog.name, time, error: `review spawn failed: ${failure.error}` }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

// §7.2, §7.4, §7.5: a free watchdog with a due review takes all updates that wait into one review, with its
// recap (§7.7); a try or a retry starts as `start` says (§12.3). The spawn is awaited inside a live hook, and
// the in-flight window spans it (§7.3). A reject or a deny started no agent (§12.2). The agent id may come
// only from the `agent.spawn` hook (§16.2), so a resolve without one keeps the slot.
const spawnReview = async ($: EngineInterface, watchdog: Watchdog, start: Start = {}): Promise<void> => {
  const batch = pendingBatch(currentFeed(), watchdog.slug);
  if (batch === undefined || !isReady(watchdog.slug, start)) {
    return;
  }
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: batch.end, ...start });
  await refreshAgent($, watchdog);
  const prompt = reviewPrompt(
    { updates: batch.updates, ...(await recapOf($, watchdog.slug)) },
    { isCompact: start.isCompact === true }
  );
  beginSpawn();
  const spawned = await $.agent
    .spawn({
      subagentType: agentType(watchdog.slug),
      description: reviewDescription(watchdog),
      prompt,
    })
    .catch((error: unknown) => ({ deny: errorText(error) }))
    .finally(endSpawn);
  if (spawned.deny !== undefined) {
    await spawnFailed($, watchdog, { error: spawned.deny, from: start.from, batchEnd: batch.end });
    return;
  }
  setCadence(watchdog.slug, { ...cadenceOf(watchdog.slug), isDue: false });
  rememberPrompt({ watchdog: watchdog.name, prompt });
  if (spawned.agentId !== undefined) {
    learnReviewAgent(watchdog.slug, spawned.agentId);
  }
};

const reviewAll = async ($: EngineInterface, watchdogs: readonly Watchdog[], start: Start = {}): Promise<void> => {
  await Promise.all(watchdogs.map((watchdog) => spawnReview($, watchdog, start)));
  await save($);
};

// §7.2: a main-loop boundary closes an update before `next(e)`, so the rows of the next step stay out.
// §7.4: each watchdog counts the boundary by its cadence; a `step` close is mid-turn.
const closeMainUpdate = (agentId: string | undefined, close: UpdateClose): boolean => {
  const isBoundary = agentId === undefined && currentMode() === 'on';
  if (isBoundary) {
    setFeed(closeUpdate(currentFeed(), close));
    currentRoster().forEach((watchdog) => {
      setCadence(watchdog.slug, countBoundary(cadenceOf(watchdog.slug), watchdog, close !== 'step'));
    });
  }
  return isBoundary;
};

// §7.5, §12.1 to §12.3: a review's own `turn.complete` frees its watchdog and applies its outcome; the error
// goes to `last error` and to the review's record. Returns what starts next: the compact retry at once, or
// the next review after an answer or a refusal that left the watchdog idle (§12.2 model compare first).
const finishReview = async (
  $: EngineInterface,
  e: TurnCompleteInput
): Promise<{ slug: string; start: Start } | undefined> => {
  const review = runningReview(e.agentId);
  if (review === undefined) {
    return undefined;
  }
  const { slot, watchdog } = review;
  const { outcome, notes } = endOutcome(e, review);
  applyOutcome(watchdog.slug, outcome, { from: slot.from, notes, now: await $.clock.now(), batchEnd: slot.batchEnd });
  if (outcome.kind === 'retry') {
    return { slug: watchdog.slug, start: { isCompact: true, from: slot.from } };
  }
  const isNext = (e.reason === 'answer' || e.reason === 'refusal') && slotOf(watchdog.slug).state === 'idle';
  return isNext ? { slug: watchdog.slug, start: {} } : undefined;
};

// §7.2: main-loop `turn.step` with index ≥ 1 is a boundary; the reviews spawn after the step's stream.
// §6.2: the main loop's step names the session effort. §7.6: the step's server tool calls that no row named
// join the open update.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined) {
    setSessionEffort(e.effort);
  }
  const isBoundary = e.index >= 1 && closeMainUpdate(e.agentId, 'step');
  const response = yield* next(e);
  if (e.agentId === undefined && currentMode() === 'on') {
    setFeed(addServerToolUses(currentFeed(), response.serverToolUses ?? []));
  }
  if (isBoundary) {
    await reviewAll($, currentRoster());
  }
  return response;
};

// §7.2: main-loop `turn.complete` is a boundary; §7.5: an Esc closes the update as interrupted. A review's
// own `turn.complete` spawns the next review of that watchdog, or its compact retry (§12.3 item 4), awaited
// there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeMainUpdate(e.agentId, e.isAborted ? 'interrupted' : 'turn');
  const finished = await finishReview($, e);
  const result = await next(e);
  const isNext = (watchdog: Watchdog): boolean => watchdog.slug === finished?.slug && currentMode() === 'on';
  if (isBoundary || finished !== undefined) {
    await reviewAll($, isBoundary ? currentRoster() : currentRoster().filter(isNext), finished?.start);
  }
  return result;
};

// §12.3 items 2, 3: a person prompt (§10) tries one review of each `limited` watchdog, and of each `halted`
// one whose wait passed, with all updates that wait. The spawn is awaited in this live hook (§7.2).
const onPersonPrompt: Hook<'prompt.submit'> = async ($, e, next) => {
  const result = await next(e);
  if (currentMode() !== 'on' || !isPersonPrompt(e.origin)) {
    return result;
  }
  const now = await $.clock.now();
  await Promise.all(
    currentRoster().map(async (watchdog) => {
      const from = dueTry(slotOf(watchdog.slug), now);
      return from === undefined ? undefined : spawnReview($, watchdog, { from });
    })
  );
  await save($);
  return result;
};

export const installReview = (on: OnEvents<'turn.step' | 'turn.complete' | 'prompt.submit'>): void => {
  on('turn.step', onStep);
  on('turn.complete', onComplete);
  on('prompt.submit', { origin: { kind: /^/u } }, onPersonPrompt);
  addStatusLines(watchdogStatusLines, 'watchdogs');
  addStatusLines(rosterLines);
  addStatusLines(lastErrorStatus, 'error');
};
