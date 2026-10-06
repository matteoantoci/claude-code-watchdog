import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { registeredSpec, setRegisteredSpec } from '../agents/registered';
import { currentRoster, rosterStatusLines } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { isPersonPrompt } from '../delivery/person';
import { errorText } from '../errors';
import { classifySpawnError, reviewOutcome } from '../failure/classify';
import { dueTry } from '../failure/health';
import {
  applyOutcome,
  deliveredNotes,
  healthParts,
  lastErrorLines,
  setLastError,
  takeAgentFacts,
} from '../failure/state';
import { closeUpdate, currentFeed, pendingBatch, setFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { addLogRecord, currentLog, errorRecord, rememberPrompt, traceError, traceOf } from '../log/log';
import { resolveEffort, sessionEffort, setSessionEffort } from '../roster/model';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { reviewPrompt } from './prompt';
import { learnReviewAgent, runningReview, setSlot, slotLine, slotOf } from './slots';
import type { Watchdog } from '../agents/roster';
import type { OnEvents } from '../on';
import type { Problem } from './slots';
import type { EngineInterface, Hook, TurnCompleteInput } from 'claude-code';

// The live copies are module memory; `$.state` keeps them across a reload (§14.1), so a refused write
// loses only that carry-over.
const save = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'ids' }, watchdogIds()).catch(() => undefined);
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

// How a review starts: at a boundary when its cadence is due (§7.4); as the try of a `limited` or `halted`
// watchdog at a person prompt (§12.3 items 2, 3), which keeps the problem it starts from; or as the compact
// retry at once of a prompt too large (§12.3 item 4), which keeps the problem of the review it repeats.
type Start = { readonly from?: Problem; readonly isCompact?: boolean };

const isReady = (slug: string, start: Start): boolean => {
  const slot = slotOf(slug);
  if (start.isCompact === true) {
    return slot.state === 'idle';
  }
  return start.from === undefined ? slot.state === 'idle' && cadenceOf(slug).isDue : slot === start.from;
};

// §12.2: a spawn that started no agent gives `blocked`, a cap (no failure; the batch waits for the next
// boundary) or 1 failure. The error goes to `last error` and to the dump.
const spawnFailed = async (
  $: EngineInterface,
  watchdog: Watchdog,
  failure: { error: string; from: Problem | undefined; batchEnd: string }
): Promise<void> => {
  const time = await $.clock.now();
  const outcome = { kind: classifySpawnError(failure.error), error: failure.error };
  applyOutcome(watchdog.slug, outcome, { from: failure.from, notes: 0, now: time, batchEnd: failure.batchEnd });
  setLastError(watchdog.name, failure.error);
  addLogRecord(errorRecord({ watchdog: watchdog.name, time, error: `review spawn failed: ${failure.error}` }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

// §7.2, §7.4, §7.5: a free watchdog with a due review takes all updates that wait into one review. The spawn
// is awaited inside a live hook, and the in-flight window spans it (§7.3). A reject or a deny started no
// agent (§12.2). The agent id may come only from the `agent.spawn` hook (§16.2), so a resolve without one
// keeps the slot.
const spawnReview = async ($: EngineInterface, watchdog: Watchdog, start: Start = {}): Promise<void> => {
  const batch = pendingBatch(currentFeed(), watchdog.slug);
  if (batch === undefined || !isReady(watchdog.slug, start)) {
    return;
  }
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: batch.end, ...start });
  await refreshAgent($, watchdog);
  beginSpawn();
  const prompt = reviewPrompt(batch.rows, { isCompact: start.isCompact === true });
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
// §7.4: each watchdog counts the boundary by its cadence.
const closeMainUpdate = (agentId: string | undefined, isTurnEnd: boolean): boolean => {
  const isBoundary = agentId === undefined && currentMode() === 'on';
  if (isBoundary) {
    setFeed(closeUpdate(currentFeed()));
    currentRoster().forEach((watchdog) => {
      setCadence(watchdog.slug, countBoundary(cadenceOf(watchdog.slug), watchdog, isTurnEnd));
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
  const { agentId, slot, watchdog } = review;
  const trace = traceOf(agentId);
  const facts = takeAgentFacts(agentId);
  const outcome = reviewOutcome({
    end: e,
    errorText: facts.errorText,
    steps: trace.steps,
    isCompact: slot.isCompact === true,
    model: watchdog.model,
    ran: e.usage?.model ?? facts.spawnModel,
  });
  if (outcome.error !== null) {
    traceError(agentId, outcome.error);
    setLastError(watchdog.name, outcome.error);
  }
  const now = await $.clock.now();
  applyOutcome(watchdog.slug, outcome, {
    from: slot.from,
    notes: deliveredNotes(trace.notes),
    now,
    batchEnd: slot.batchEnd,
  });
  if (outcome.kind === 'retry') {
    return { slug: watchdog.slug, start: { isCompact: true, from: slot.from } };
  }
  const isNext = (e.reason === 'answer' || e.reason === 'refusal') && slotOf(watchdog.slug).state === 'idle';
  return isNext ? { slug: watchdog.slug, start: {} } : undefined;
};

// §7.2: main-loop `turn.step` with index ≥ 1 is a boundary; the reviews spawn after the step's stream.
// §6.2: the main loop's step names the session effort.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined) {
    setSessionEffort(e.effort);
  }
  const isBoundary = e.index >= 1 && closeMainUpdate(e.agentId, false);
  const response = yield* next(e);
  if (isBoundary) {
    await reviewAll($, currentRoster());
  }
  return response;
};

// §7.2: main-loop `turn.complete` is a boundary. §7.5: a review's own `turn.complete` spawns the next
// review of that watchdog, or its compact retry (§12.3 item 4), awaited there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeMainUpdate(e.agentId, true);
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
  // §13.3: each watchdog with its state, its failure parts (§12.4) and the file that added it, then the
  // roster lines (§4.5, §4.6) and the last error (§12.4).
  addStatusLines(() =>
    currentMode() === 'on'
      ? [
          ...currentRoster().map((watchdog) =>
            [
              slotLine(watchdog.name, slotOf(watchdog.slug)),
              ...healthParts(watchdog.slug),
              ...(watchdog.source === null ? [] : [watchdog.source]),
            ].join(' · ')
          ),
          ...rosterStatusLines(),
          ...lastErrorLines(),
        ]
      : []
  );
};
