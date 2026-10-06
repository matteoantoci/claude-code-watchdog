import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { registeredSpec, setRegisteredSpec } from '../agents/registered';
import { currentRoster, rosterStatusLines } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { errorText } from '../errors';
import {
  addServerToolUses,
  closeUpdate,
  currentFeed,
  moveCursor,
  pendingBatch,
  setFeed,
  unreviewedCalls,
} from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession } from '../lifecycle/on-order';
import { addLogRecord, currentLog, rememberPrompt, unreviewedRecord } from '../log/log';
import { liveHistory, notesKey, readHistory, watchdogNotes } from '../note/history';
import { resolveEffort, sessionEffort, setSessionEffort } from '../roster/model';
import { dropBacklog, isUnboundReject, waitingUpdates } from './backlog';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { reviewPrompt } from './prompt';
import { IDLE, learnReviewAgent, reviewOf, setSlot, slotLine, slotOf } from './slots';
import type { Watchdog } from '../agents/roster';
import type { UpdateClose } from '../feed/feed';
import type { RecapNote } from '../note/history';
import type { OnEvents } from '../on';
import type { ReviewInput } from './prompt';
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
// goes, with one `unreviewed: N updates` record for the dump file (§10.6); no failure counts.
const dropUnbound = async ($: EngineInterface, watchdog: Watchdog, reason: string): Promise<void> => {
  if (isInteractiveSession() || !isUnboundReject(reason)) {
    return;
  }
  const updates = waitingUpdates(currentFeed(), currentFeed().cursors[watchdog.slug]);
  setFeed(dropBacklog(currentFeed(), watchdog.slug));
  addLogRecord(unreviewedRecord({ watchdog: watchdog.name, time: await $.clock.now(), updates }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

// §7.2, §7.4, §7.5: a free watchdog with a due review takes all updates that wait into one review, with its
// recap (§7.7). The spawn
// is awaited inside a live hook, and the in-flight window spans it (§7.3). A reject or a deny started no
// agent: the slot is free again and the batch waits for the next boundary. The agent id may come only from
// the `agent.spawn` hook (§16.2), so a resolve without one keeps the slot.
const spawnReview = async ($: EngineInterface, watchdog: Watchdog): Promise<void> => {
  const batch = pendingBatch(currentFeed(), watchdog.slug);
  if (batch === undefined || slotOf(watchdog.slug).state !== 'idle' || !cadenceOf(watchdog.slug).isDue) {
    return;
  }
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: batch.end });
  await refreshAgent($, watchdog);
  const prompt = reviewPrompt({ updates: batch.updates, ...(await recapOf($, watchdog.slug)) });
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
    await dropUnbound($, watchdog, spawned.deny);
    return;
  }
  setCadence(watchdog.slug, { ...cadenceOf(watchdog.slug), isDue: false });
  rememberPrompt({ watchdog: watchdog.name, prompt });
  if (spawned.agentId !== undefined) {
    learnReviewAgent(watchdog.slug, spawned.agentId);
  }
};

const reviewAll = async ($: EngineInterface, watchdogs: readonly Watchdog[]): Promise<void> => {
  await Promise.all(watchdogs.map((watchdog) => spawnReview($, watchdog)));
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

// §7.5: a review's own `turn.complete` frees its watchdog. An answer or a refusal moves the cursor and
// returns the slug; any other end puts the batch back.
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
  setFeed(moveCursor(currentFeed(), slug, slot.batchEnd));
  return slug;
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
// own `turn.complete` spawns the next review of that watchdog, awaited there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeMainUpdate(e.agentId, e.isAborted ? 'interrupted' : 'turn');
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
