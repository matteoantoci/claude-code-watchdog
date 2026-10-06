import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { registeredSpec, setRegisteredSpec } from '../agents/registered';
import { currentRoster } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { errorText } from '../errors';
import { classifySpawnError } from '../failure/classify';
import { dueTry } from '../failure/health';
import { applyOutcome, endOutcome, setLastError } from '../failure/state';
import { addServerToolUses, currentFeed, setFeed, unreviewedCalls } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession } from '../lifecycle/on-order';
import { addLogRecord, currentLog, errorRecord, rememberPrompt, unreviewedRecord } from '../log/log';
import { liveHistory, notesKey, readHistory, watchdogNotes } from '../note/history';
import { isPersonPrompt } from '../person';
import { resolveEffort, sessionEffort, setSessionEffort } from '../roster/model';
import { taskPrompts } from '../subagents/watch';
import { dropBacklog, isUnboundReject, waitingUpdates } from './backlog';
import { cadenceKey, closeBacklog, takeBacklog, watchersOf } from './backlogs';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { reviewPrompt } from './prompt';
import { IDLE, isReady, learnReviewAgent, runningReview, setSlot, slotOf } from './slots';
import { watchdogStatusLines } from './status';
import type { Watchdog } from '../agents/roster';
import type { UpdateClose } from '../feed/feed';
import type { RecapNote } from '../note/history';
import type { OnEvents } from '../on';
import type { WatchedSubagent } from '../subagents/watch';
import type { Backlog } from './backlogs';
import type { ReviewInput } from './prompt';
import type { Problem, Start } from './slots';
import type { EngineInterface, Hook, TurnCompleteInput } from 'claude-code';

// The live copies are module memory; `$.state` keeps them across a reload (§14.1), so a refused write
// loses only that carry-over.
const save = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'ids' }, watchdogIds()).catch(() => undefined);
};

// §7.7 part 1: the watchdog's newest 20 notes on the watched agent: the note area's live copy of
// `notes:<sessionId>` (or `notes:<sessionId>:<agentId>` of a subagent, §11.4), else the stored value.
const recapNotes = async ($: EngineInterface, slug: string, agentId?: string): Promise<readonly RecapNote[]> => {
  const sessionId = await $.session.id();
  const history = liveHistory(sessionId, agentId) ?? readHistory(await $.store.get(notesKey(sessionId, agentId)));
  return watchdogNotes(history, slug).notes;
};

// §7.7, §11.4: the recap of a subagent review reads that subagent's conversation; its part 2 is the task.
const subagentRecap = async (
  $: EngineInterface,
  slug: string,
  backlog: Backlog & { readonly subagent: WatchedSubagent }
): Promise<Omit<ReviewInput, 'updates'>> => {
  const { subagent } = backlog;
  const [notes, messages] = await Promise.all([
    recapNotes($, slug, subagent.agentId).catch(() => []),
    $.session.messages({ agentId: subagent.agentId, as: 'api' }).then(
      (read) => (Array.isArray(read) ? read : []),
      () => []
    ),
  ]);
  const prompts = taskPrompts(subagent, backlog.batch.rows);
  return { notes, messages, prompts, skip: unreviewedCalls(subagent.feed, slug), subagent: subagent.type };
};

// §7.7: the recap of one review. Parts 2 and 3 read the main conversation in Messages API form; a refused
// read leaves its parts empty.
const recapOf = async ($: EngineInterface, slug: string, backlog: Backlog): Promise<Omit<ReviewInput, 'updates'>> => {
  if (backlog.subagent !== undefined) {
    return subagentRecap($, slug, { ...backlog, subagent: backlog.subagent });
  }
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
  failure: { error: string; from: Problem | undefined; batchEnd: string; subagent: string | undefined }
): Promise<void> => {
  setSlot(watchdog.slug, failure.from ?? IDLE);
  if (await dropUnbound($, watchdog, failure.error)) {
    return;
  }
  const time = await $.clock.now();
  const outcome = { kind: classifySpawnError(failure.error), error: failure.error };
  const { from, batchEnd, subagent } = failure;
  applyOutcome(watchdog.slug, outcome, { from, notes: 0, now: time, batchEnd, subagent });
  setLastError(watchdog.name, failure.error);
  addLogRecord(errorRecord({ watchdog: watchdog.name, time, error: `review spawn failed: ${failure.error}` }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

// §7.2, §7.4, §7.5, §11.2: a free watchdog merges the backlog with the oldest due update into one review with
// its recap (§7.7); a try or a retry starts as `start` says (§12.3). The spawn is awaited in a live hook (§7.3);
// a reject or deny started no agent (§12.2); a resolve without an id keeps the slot (§16.2).
const spawnReview = async ($: EngineInterface, watchdog: Watchdog, start: Start = {}): Promise<void> => {
  const backlog = isReady(watchdog.slug, start) ? takeBacklog(watchdog.slug, start) : undefined;
  if (backlog === undefined) {
    return;
  }
  const subagent = backlog.subagent?.agentId;
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: backlog.batch.end, ...start, subagent });
  await refreshAgent($, watchdog);
  const prompt = reviewPrompt(
    { updates: backlog.batch.updates, ...(await recapOf($, watchdog.slug, backlog)) },
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
    const failure = { error: spawned.deny, from: start.from, batchEnd: backlog.batch.end, subagent };
    await spawnFailed($, watchdog, failure);
    return;
  }
  const pair = cadenceKey(watchdog.slug, subagent);
  setCadence(pair, { ...cadenceOf(pair), isDue: false });
  rememberPrompt({ watchdog: watchdog.name, prompt });
  if (spawned.agentId !== undefined) {
    learnReviewAgent(watchdog.slug, spawned.agentId);
  }
};

const reviewAll = async ($: EngineInterface, watchdogs: readonly Watchdog[], start: Start = {}): Promise<void> => {
  await Promise.all(watchdogs.map((watchdog) => spawnReview($, watchdog, start)));
  await save($);
};

// §7.2, §11.2: a boundary of a watched agent closes its update before `next(e)`, so the rows of the next step
// stay out. §7.4: each of its watchdogs counts the boundary by its cadence; a `step` close is mid-turn.
const closeWatchedUpdate = (agentId: string | undefined, close: UpdateClose): boolean => {
  const watchers = currentMode() === 'on' ? watchersOf(agentId, currentRoster()) : undefined;
  if (watchers === undefined) {
    return false;
  }
  closeBacklog(agentId, close);
  watchers.forEach((watchdog) => {
    const pair = cadenceKey(watchdog.slug, agentId);
    setCadence(pair, countBoundary(cadenceOf(pair), watchdog, close !== 'step'));
  });
  return true;
};

// §7.5, §12.1 to §12.3: a review's own `turn.complete` frees its watchdog and applies its outcome to the backlog
// it took (§11.2). Returns what starts next: the compact retry at once, or the next review after an answer or a
// refusal that left the watchdog idle (§12.2 model compare first).
const finishReview = async (
  $: EngineInterface,
  e: TurnCompleteInput
): Promise<{ slug: string; start: Start } | undefined> => {
  const review = runningReview(e.agentId);
  if (review === undefined) {
    return undefined;
  }
  const { slot, watchdog } = review;
  const { from, batchEnd, subagent } = slot;
  const { outcome, notes } = endOutcome(e, review);
  applyOutcome(watchdog.slug, outcome, { from, notes, now: await $.clock.now(), batchEnd, subagent });
  if (outcome.kind === 'retry') {
    return { slug: watchdog.slug, start: { isCompact: true, from, subagent } };
  }
  const isNext = (e.reason === 'answer' || e.reason === 'refusal') && slotOf(watchdog.slug).state === 'idle';
  return isNext ? { slug: watchdog.slug, start: {} } : undefined;
};

// §7.2, §11.2: a watched agent's `turn.step` with index ≥ 1 is a boundary; the reviews spawn after the step's
// stream. §6.2: the main loop's step names the session effort. §7.6: the step's server tool calls that no
// row named join the primary agent's open update.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined) {
    setSessionEffort(e.effort);
  }
  const isBoundary = e.index >= 1 && closeWatchedUpdate(e.agentId, 'step');
  const response = yield* next(e);
  if (e.agentId === undefined && currentMode() === 'on') {
    setFeed(addServerToolUses(currentFeed(), response.serverToolUses ?? []));
  }
  if (isBoundary) {
    await reviewAll($, currentRoster());
  }
  return response;
};

// §7.2, §11.2: a watched agent's `turn.complete` is a boundary; §7.5: an Esc closes the update as interrupted.
// A review's own `turn.complete` spawns the next review of that watchdog, or its compact retry (§12.3 item 4),
// awaited there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeWatchedUpdate(e.agentId, e.isAborted ? 'interrupted' : 'turn');
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
  addStatusLines(watchdogStatusLines);
};
