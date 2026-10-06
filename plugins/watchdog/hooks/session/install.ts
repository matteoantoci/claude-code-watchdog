import { addWatchdogId } from '../agents/ids';
import { EMPTY_BAND, bandState, restoreBand } from '../band/cards';
import { currentTurn } from '../delivery/turns';
import { currentFeed, startFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { setSurfacesAtStart } from '../lifecycle/on-order';
import { restoreLog } from '../log/log';
import { liveHistory, notesKey, readHistory, setLiveHistory } from '../note/history';
import { changeBacklog } from '../review/backlogs';
import { forgetMark } from '../rewind/mark';
import { currentReviews } from '../stop/reviews';
import { forgetSubagents, restoreSubagent, setReviewTarget } from '../subagents/watch';
import { resetScope } from '../tools/scope';
import { discardNotes, endSession, keepCommand, takeChange } from './change';
import { resumeFeed } from './load';
import { replayFeed } from './replay';
import type { OnEvents } from '../on';
import type { Carried, SessionChange } from './change';
import type { EngineInterface, Hook, PluginState } from 'claude-code';

type Loaded = { readonly [K in 'ids' | 'log' | 'feed']: PluginState['watchdog'][K] | undefined };

// §14.1, §14.3: the values that carry over, as the old session's `$.state` holds them at its end; a refused read
// carries nothing over.
const readCarried = async ($: EngineInterface): Promise<Carried> => {
  const [on, ids, health, turns, reviews] = await Promise.all([
    $.state.get({ plugin: 'watchdog', key: 'on' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'ids' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'health' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'turns' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'reviews' }).then(
      (read) => read.value,
      () => undefined
    ),
  ]);
  return { on, ids, health, turns, reviews };
};

// §14.1: the first hook after the change writes the kept values into the new `$.state`.
const writeCarried = async ($: EngineInterface, { on, ids, health, turns, reviews }: Carried): Promise<void> => {
  const writes = [
    on === undefined ? undefined : $.state.set({ plugin: 'watchdog', key: 'on' }, on),
    ids === undefined ? undefined : $.state.set({ plugin: 'watchdog', key: 'ids' }, ids),
    health === undefined ? undefined : $.state.set({ plugin: 'watchdog', key: 'health' }, health),
    turns === undefined ? undefined : $.state.set({ plugin: 'watchdog', key: 'turns' }, turns),
    reviews === undefined ? undefined : $.state.set({ plugin: 'watchdog', key: 'reviews' }, reviews),
  ];
  await Promise.all(writes.map(async (write) => write?.catch(() => undefined)));
};

// §9.6: `/branch` copies the old session's note history to the new id, guard keys too. `/resume` loads the
// resumed id's own history at its first note, and `/clear` starts an empty one there.
const copyHistory = async ($: EngineInterface, from: string, to: string): Promise<void> => {
  const history = liveHistory(from) ?? readHistory(await $.store.get(notesKey(from)).catch(() => undefined));
  const copy = { ...history, lastUsed: await $.clock.now() };
  setLiveHistory(to, copy);
  await $.store.set(notesKey(to), copy).catch(() => undefined);
};

// §14.3: `/resume` and `/branch` replay the new session's conversation in Messages API form; a refused read
// replays nothing.
const replay = async ($: EngineInterface, to: string): Promise<void> => {
  const messages = await $.session.messages({ as: 'api' }).catch(() => []);
  changeBacklog(undefined, (feed) => replayFeed(feed, messages, `replay:${to}`));
};

// §14.3: the backlogs, the cards and the notes that wait reset, and the read-scope allow set and deny counts
// empty (§14.1); the on flag, the id set, the failure states, the turn counter, the reviews and the stop map
// carry over.
const applyChange = async ($: EngineInterface, change: SessionChange, to: string): Promise<void> => {
  discardNotes();
  forgetSubagents();
  forgetMark();
  resetScope();
  restoreBand(EMPTY_BAND);
  changeBacklog(undefined, (feed) => startFeed(Object.keys(feed.cursors)));
  if (change.kind === 'branch') {
    await copyHistory($, change.from, to);
  }
  if (change.kind !== 'clear' && currentMode() === 'on') {
    await replay($, to);
  }
  await writeCarried($, change.carried);
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'band' }, bandState(currentTurn())).catch(() => undefined);
};

// §14.3: the command is kept before `next(e)`, inside which `session.end` fires; right after it the session id
// is the new one. A command that changed no session id (a `/resume` picker closed with no pick) changes nothing.
const onSessionCommand: Hook<'command.run'> = async ($, e, next) => {
  keepCommand(e.command);
  const result = await next(e);
  const change = takeChange();
  const to = change === undefined ? undefined : await $.session.id();
  if (change !== undefined && to !== undefined && to !== change.from) {
    await applyChange($, change, to);
  }
  return result;
};

// §14.3: the old session ends; its `$.state` still answers here. The stop area beneath stopped its reviews.
const onSessionEnd: Hook<'session.end'> = async ($, e, next) => {
  const result = await next(e);
  endSession(e.sessionId, e.reason === 'clear' ? 'clear' : 'resume', await readCarried($));
  return result;
};

// §14.6: what a reload finds in `$.state` before the hooks beneath run: the id set, the review log, the feed.
const readLoad = async ($: EngineInterface): Promise<Loaded> => {
  const [ids, log, feed] = await Promise.all([
    $.state.get({ plugin: 'watchdog', key: 'ids' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'log' }).then(
      (read) => read.value,
      () => undefined
    ),
    $.state.get({ plugin: 'watchdog', key: 'feed' }).then(
      (read) => read.value,
      () => undefined
    ),
  ]);
  return { ids, log, feed };
};

// §11.2, §14.6: the watched subagents that may have work left come back from the `$.state` family
// `subagents`: the session's agents and the subagents of the reviews that run; each review agent that runs
// reviews its subagent again (§11.4).
const restoreSubagents = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list().catch(() => []);
  const { running } = currentReviews();
  const agentIds = new Set([...listed.map((agent) => agent.id), ...running.flatMap((clock) => clock.subagent ?? [])]);
  const found = await Promise.all(
    [...agentIds].map(async (agentId) =>
      $.state.get({ plugin: 'watchdog', key: 'subagents', id: agentId }).then(
        (read) => (read.value === undefined ? [] : [{ agentId, ...read.value }]),
        () => []
      )
    )
  );
  found.flat().forEach((watch) => restoreSubagent(watch));
  running.forEach((clock) => {
    if (clock.agentId !== null) {
      setReviewTarget(clock.agentId, clock.subagent);
    }
  });
};

// §14.6: the stored feed replaces the one the on order started; none was stored before the first `on`.
const restoreFeed = async ($: EngineInterface, feed: Loaded['feed']): Promise<void> => {
  if (feed === undefined) {
    return;
  }
  changeBacklog(undefined, (started) => resumeFeed(feed, started));
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §14.6: at load (the first hook of a module instance) the id set and the review log come back before the
// hooks beneath run, and a desktop reload notes its surfaces (§5.3). The feed and the watched subagents come
// back once the on order beneath turned the session on again, which started the feed anew.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  setSurfacesAtStart(e.isInteractive ? [] : await $.session.surfaces().catch(() => []));
  const { ids, log, feed } = await readLoad($);
  ids?.forEach((id) => addWatchdogId(id.agentId, id.watchdog));
  restoreLog(log ?? []);
  const result = await next(e);
  if (currentMode() === 'on') {
    await restoreFeed($, feed);
    await restoreSubagents($);
  }
  return result;
};

// Install above the stop area, whose `session.end` hook stops the reviews before this one reads the stop map,
// and whose `session.start` hook rebuilds the reviews before this one reads them. The matchers only tell these
// `on()` from the other areas'.
export const installSession = (on: OnEvents<'command.run' | 'session.end' | 'session.start'>): void => {
  on('command.run', { command: ['branch', 'resume', 'clear'] }, onSessionCommand);
  on('session.end', { reason: /^(?:clear|resume)$/u }, onSessionEnd);
  on('session.start', { cwd: /./u }, onSessionStart);
};
