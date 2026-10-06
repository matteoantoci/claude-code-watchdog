import { beginSpawn, endSpawn, watchdogIds } from '../agents/ids';
import { currentRoster } from '../agents/roster';
import { agentType, reviewDescription } from '../agents/spec';
import { addStatusLines } from '../command/status';
import { errorText } from '../errors';
import { closeUpdate, currentFeed, moveCursor, pendingBatch, setFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { rememberPrompt } from '../log/log';
import { reviewPrompt } from './prompt';
import { IDLE, learnReviewAgent, reviewOf, setSlot, slotLine, slotOf } from './slots';
import type { Watchdog } from '../agents/roster';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, TurnCompleteInput } from 'claude-code';

// The live copies are module memory; `$.state` keeps them across a reload (§14.1), so a refused write
// loses only that carry-over.
const save = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'ids' }, watchdogIds()).catch(() => undefined);
};

// §7.2, §7.5: a free watchdog takes all updates that wait into one review. The spawn is awaited inside a
// live hook, and the in-flight window spans it (§7.3). A reject or a deny started no agent: the slot is
// free again and the batch waits for the next boundary. The agent id may come only from the `agent.spawn`
// hook (§16.2), so a resolve without one keeps the slot.
const spawnReview = async ($: EngineInterface, watchdog: Watchdog): Promise<void> => {
  const batch = pendingBatch(currentFeed(), watchdog.slug);
  if (batch === undefined || slotOf(watchdog.slug).state !== 'idle') {
    return;
  }
  setSlot(watchdog.slug, { state: 'reviewing', agentId: null, batchEnd: batch.end });
  beginSpawn();
  const prompt = reviewPrompt(batch.rows);
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
const closeMainUpdate = (agentId: string | undefined): boolean => {
  const isBoundary = agentId === undefined && currentMode() === 'on';
  if (isBoundary) {
    setFeed(closeUpdate(currentFeed()));
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
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  const isBoundary = e.index >= 1 && closeMainUpdate(e.agentId);
  const response = yield* next(e);
  if (isBoundary) {
    await reviewAll($, currentRoster());
  }
  return response;
};

// §7.2: main-loop `turn.complete` is a boundary. §7.5: a review's own `turn.complete` spawns the next
// review of that watchdog, awaited there.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const isBoundary = closeMainUpdate(e.agentId);
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
  addStatusLines(() =>
    currentMode() === 'on' ? currentRoster().map((watchdog) => slotLine(watchdog.name, slotOf(watchdog.slug))) : []
  );
};
