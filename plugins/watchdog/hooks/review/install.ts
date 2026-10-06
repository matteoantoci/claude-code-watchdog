import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { registeredSpec, setRegisteredSpec } from '../agents/registered';
import { currentRoster, rosterStatusLines } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { errorText } from '../errors';
import { addServerToolUses, currentFeed, setFeed, unreviewedCalls } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { rememberPrompt } from '../log/log';
import { liveHistory, notesKey, readHistory, watchdogNotes } from '../note/history';
import { resolveEffort, sessionEffort, setSessionEffort } from '../roster/model';
import { taskPrompts } from '../subagents/watch';
import { cadenceKey, closeBacklog, moveBacklogCursor, takeBacklog, watchersOf } from './backlogs';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { reviewPrompt } from './prompt';
import { IDLE, learnReviewAgent, reviewOf, setSlot, slotLine, slotOf } from './slots';
import type { Watchdog } from '../agents/roster';
import type { UpdateClose } from '../feed/feed';
import type { RecapNote } from '../note/history';
import type { OnEvents } from '../on';
import type { WatchedSubagent } from '../subagents/watch';
import type { Backlog } from './backlogs';
import type { ReviewInput } from './prompt';
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

// §4.5, §6.2: before each spawn, the `:auto` effort of now; the type registers again only when it changed.
// A register reject keeps the type as it was (§6.1).
const refreshAgent = async ($: EngineInterface, watchdog: Watchdog): Promise<void> => {
  const registered = registeredSpec(watchdog.slug);
  const effort = resolveEffort(watchdog.effort, sessionEffort());
  if (registered === undefined || registered.effort === effort) {
    return;
  }
  const spec = { ...registered, effort };
  await $.agent.register(spec).then(
    () => setRegisteredSpec(spec),
    () => undefined
  );
};

// §7.2, §7.4, §7.5: a free watchdog takes the backlog with the oldest due update (§11.2: the primary agent's
// or a watched subagent's) and merges all its updates into one review, with its recap (§7.7). The spawn
// is awaited inside a live hook, and the in-flight window spans it (§7.3). A reject or a deny started no
// agent: the slot is free again and the batch waits for the next boundary. The agent id may come only from
// the `agent.spawn` hook (§16.2), so a resolve without one keeps the slot.
const spawnReview = async ($: EngineInterface, watchdog: Watchdog): Promise<void> => {
  const backlog = slotOf(watchdog.slug).state === 'idle' ? takeBacklog(watchdog.slug) : undefined;
  if (backlog === undefined) {
    return;
  }
  const subagent = backlog.subagent?.agentId;
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: backlog.batch.end, subagent });
  await refreshAgent($, watchdog);
  const prompt = reviewPrompt({ updates: backlog.batch.updates, ...(await recapOf($, watchdog.slug, backlog)) });
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
    setSlot(watchdog.slug, IDLE);
    return;
  }
  const pair = cadenceKey(watchdog.slug, subagent);
  setCadence(pair, { ...cadenceOf(pair), isDue: false });
  rememberPrompt({ watchdog: watchdog.name, prompt });
  if (spawned.agentId !== undefined) {
    learnReviewAgent(watchdog.slug, spawned.agentId);
  }
};

const reviewAll = async ($: EngineInterface, watchdogs: readonly Watchdog[]): Promise<void> => {
  await Promise.all(watchdogs.map((watchdog) => spawnReview($, watchdog)));
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

// §7.5: a review's own `turn.complete` frees its watchdog. An answer or a refusal moves the cursor of the
// backlog it took and returns the slug; any other end puts the batch back.
const finishReview = (e: TurnCompleteInput): string | undefined => {
  const slug = e.agentId === undefined ? undefined : reviewOf(e.agentId);
  const slot = slug === undefined ? IDLE : slotOf(slug);
  if (slug === undefined || slot.state !== 'reviewing') {
    return undefined;
  }
  setSlot(slug, IDLE);
  if (e.reason !== 'answer' && e.reason !== 'refusal') {
    return undefined;
  }
  moveBacklogCursor(slug, slot.subagent, slot.batchEnd);
  return slug;
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
// A review's own `turn.complete` spawns the next review of that watchdog, awaited there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeWatchedUpdate(e.agentId, e.isAborted ? 'interrupted' : 'turn');
  const finished = finishReview(e);
  const result = await next(e);
  if (isBoundary || finished !== undefined) {
    const isNext = (watchdog: Watchdog): boolean => watchdog.slug === finished && currentMode() === 'on';
    await reviewAll($, isBoundary ? currentRoster() : currentRoster().filter(isNext));
  }
  return result;
};

export const installReview = (on: OnEvents<'turn.step' | 'turn.complete'>): void => {
  on('turn.step', onStep);
  on('turn.complete', onComplete);
  // §13.3: each watchdog with its state and the file that added it, then the roster lines (§4.5, §4.6).
  addStatusLines(() =>
    currentMode() === 'on'
      ? [
          ...currentRoster().map((watchdog) =>
            [
              slotLine(watchdog.name, slotOf(watchdog.slug)),
              ...(watchdog.source === null ? [] : [watchdog.source]),
            ].join(' · ')
          ),
          ...rosterStatusLines(),
        ]
      : []
  );
};
