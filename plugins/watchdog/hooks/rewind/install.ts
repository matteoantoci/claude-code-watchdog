import { bandState, clearCards } from '../band/cards';
import { currentTurn } from '../delivery/turns';
import { currentFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { clearGuardKeys, liveHistory, notesKey, readHistory, setLiveHistory } from '../note/history';
import { changeBacklog } from '../review/backlogs';
import { discardNotes } from '../session/change';
import { forgetSubagents } from '../subagents/watch';
import { forgetMark, isCountDropped, noteCompaction, passBoundary, rewindFeed } from './mark';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §9.6: a rewind clears the guard keys of this session's history and keeps the 20 recap notes; a history with
// no key needs no write.
const clearKeys = async ($: EngineInterface): Promise<void> => {
  const sessionId = await $.session.id();
  const history = liveHistory(sessionId) ?? readHistory(await $.store.get(notesKey(sessionId)).catch(() => undefined));
  if (Object.values(history.watchdogs).every((notes) => notes.keys.length === 0)) {
    return;
  }
  const cleared = { ...clearGuardKeys(history), lastUsed: await $.clock.now() };
  setLiveHistory(sessionId, cleared);
  await $.store.set(notesKey(sessionId), cleared).catch(() => undefined);
};

// §14.4: the cleanup of §14.3: the backlogs, the cards that wait and the undelivered notes go, and each watched
// subagent's entry in the `$.state` family `subagents` becomes null, so a reload does not watch it again; the
// allow set stays. The stop area beneath stops each review with reason `rewind` at this boundary, before the
// review area spawns, and the next update starts with the marker.
const rewind = async ($: EngineInterface, marker: string): Promise<void> => {
  discardNotes();
  const forgotten = forgetSubagents();
  clearCards();
  changeBacklog(undefined, (feed) => rewindFeed(feed, marker));
  await clearKeys($);
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'band' }, bandState(currentTurn())).catch(() => undefined);
  await Promise.all(
    forgotten.map(async (id) => $.state.set({ plugin: 'watchdog', key: 'subagents', id }, null).catch(() => undefined))
  );
};

// §14.4: no event fires for a restore, so each main-loop boundary while on checks: a smaller step
// `messageCount` needs no read, else the message at the mark tells. A refused read checks nothing.
const checkRewind = async ($: EngineInterface, count: number | undefined): Promise<void> => {
  if (currentMode() !== 'on') {
    forgetMark();
    return;
  }
  const messages = isCountDropped(count) ? undefined : await $.session.messages().catch(() => null);
  const marker = messages === null ? undefined : passBoundary(count, messages);
  if (marker !== undefined) {
    await rewind($, marker);
  }
};

// §7.2: the main-loop boundaries, before the hooks beneath close the update.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined && e.index >= 1) {
    await checkRewind($, e.messageCount);
  }
  return yield* next(e);
};

const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId === undefined) {
    await checkRewind($, undefined);
  }
  return next(e);
};

// §14.4, §14.5: a compaction of the main conversation is not a rewind.
const onCompact: Hook<'session.compact'> = async (_$, e, next) => {
  if (e.agentId === undefined) {
    noteCompaction();
  }
  return next(e);
};

// Install above the stop and review areas. The matchers only tell these `on()` from the other areas'.
export const installRewind = (on: OnEvents<'turn.step' | 'turn.complete' | 'session.compact'>): void => {
  on('turn.step', { turnId: /./u }, onStep);
  on('turn.complete', { turnId: /./u }, onComplete);
  on('session.compact', onCompact);
};
