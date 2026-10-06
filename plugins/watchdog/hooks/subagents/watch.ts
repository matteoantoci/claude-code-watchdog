import { TYPE_PREFIX } from '../agents/spec';
import { TOOL_INPUT_CAP } from '../constants';
import { closeUpdate, moveCursor, recordRow, startFeed } from '../feed/feed';
import { contentText, elide } from '../feed/text';
import { currentPeriod } from '../lifecycle/mode';
import type { Roster } from '../agents/roster';
import type { Feed, FeedRow, UpdateClose } from '../feed/feed';
import type { LogRecord } from '../log/log';
import type { DeliveryState, HeldNote, Note } from '../note/notes';
import type { AgentSpawnInput, PluginState, SessionAppendInput } from 'claude-code';

// §11.1, §14.1: one watched subagent, as the `$.state` family `subagents` keeps it by its `agentId`.
export type SubagentState = PluginState['watchdog']['subagents']['byId'];

export type WatchedSubagent = SubagentState & { readonly agentId: string };

// §11.1: what the opt-in reads of one `agent.spawn`: its exact type, whether it is a fork or a teammate, and
// whether it happens inside a watchdog agent's loop.
export type SpawnFacts = Pick<AgentSpawnInput, 'subagentType' | 'fork' | 'isTeammate'> & {
  readonly isInWatchdog: boolean;
};

// §11.1: a `watchdog:*` key never counts, and the mod ignores it.
export const isWatchdogType = (type: string): boolean => type.startsWith(TYPE_PREFIX);

// §11.1: the watchdogs that review a spawned subagent: for the `subagents` value of its exact type, `true` means
// each watchdog that reviews, a list the listed ones that review. No wildcard. A teammate, a fork, a spawn
// inside a watchdog agent and a `watchdog:*` key never count.
export const optInSlugs = (
  subagents: Roster['subagents'],
  reviewers: readonly string[],
  spawn: SpawnFacts
): string[] => {
  const choice = Object.hasOwn(subagents, spawn.subagentType) ? subagents[spawn.subagentType] : undefined;
  const isExcluded = spawn.fork || spawn.isTeammate === true || spawn.isInWatchdog;
  if (choice === undefined || isExcluded || isWatchdogType(spawn.subagentType)) {
    return [];
  }
  return choice === true ? [...reviewers] : reviewers.filter((slug) => choice.includes(slug));
};

// §11.1, §11.4, §13.3: one line for each opted-in type with its review count, then a warning for each
// `watchdog:*` key and, once the mod saw an `agent.offer`, for each key that no offer gave.
export const subagentStatusLines = (
  keys: readonly string[],
  offered: ReadonlySet<string>,
  log: readonly LogRecord[]
): string[] => {
  const types = keys.filter((key) => !isWatchdogType(key));
  const unknown = offered.size === 0 ? [] : types.filter((type) => !offered.has(type));
  return [
    ...types.map((type) => {
      const count = log.filter((record) => record.kind === 'review' && record.subagent?.type === type).length;
      return `subagents: ${type} ${count} ${count === 1 ? 'review' : 'reviews'}`;
    }),
    ...keys.filter(isWatchdogType).map((key) => `warning: subagents "${key}": a watchdog type, ignored`),
    ...unknown.map((type) => `warning: subagents "${type}": no agent.offer gave this type`),
  ];
};

// The watched subagents and the review agents of their reviews (review agentId → subagent agentId), in module
// memory; `dirty` holds the ids whose `$.state` copy is behind. They belong to one on/off period (§5.2:
// `/watchdog on` and `/watchdog off` start the feeds again).
const memory = {
  period: -1,
  watches: new Map<string, WatchedSubagent>(),
  reviews: new Map<string, string>(),
  dirty: new Set<string>(),
};

const live = (): typeof memory => {
  if (memory.period !== currentPeriod()) {
    memory.period = currentPeriod();
    memory.watches.clear();
    memory.reviews.clear();
    memory.dirty.clear();
  }
  return memory;
};

const setWatch = (watch: WatchedSubagent): WatchedSubagent => {
  live().watches.set(watch.agentId, watch);
  memory.dirty.add(watch.agentId);
  return watch;
};

// One change to a watched subagent; undefined when the mod does not watch it.
const changeWatch = (
  agentId: string,
  change: (watch: WatchedSubagent) => Partial<SubagentState>
): WatchedSubagent | undefined => {
  const watch = live().watches.get(agentId);
  return watch === undefined ? undefined : setWatch({ ...watch, ...change(watch) });
};

// The uuid of a subagent's task row is its `agentId` and this suffix.
const TASK_ROW = ':task';

// §11.2: a subagent the mod learned from an opted-in `agent.spawn`. Its feed starts with the spawn `prompt` as
// its task, the first row of its first update, cut as a tool input (§7.6).
export const watchSubagent = (spawn: Omit<WatchedSubagent, 'feed' | 'isRunning'>): WatchedSubagent => {
  const text = `**task** (subagent ${spawn.type}):\n${elide(spawn.task, TOOL_INPUT_CAP)}`;
  const task: FeedRow = { uuid: `${spawn.agentId}${TASK_ROW}`, text, brief: text };
  return setWatch({ ...spawn, isRunning: true, feed: { ...startFeed(spawn.watchdogs), rows: [task] } });
};

export const watchedSubagent = (agentId: string | undefined): WatchedSubagent | undefined =>
  agentId === undefined ? undefined : live().watches.get(agentId);

export const watchedSubagents = (): readonly WatchedSubagent[] => [...live().watches.values()];

// §11.2, §7.3: a row of a watched subagent enters its feed rendered (§7.6). The caller leaves out the
// watchdog's own rows. The prompt row of the task is left out too: the feed starts with it.
export const recordSubagentRow = (row: SessionAppendInput): boolean => {
  const watch = watchedSubagent(row.agentId);
  if (watch === undefined || (row.door === 'prompt' && contentText(row.message.content).includes(watch.task))) {
    return false;
  }
  setWatch({ ...watch, feed: recordRow(watch.feed, row) });
  return true;
};

// §11.2: the subagent's `turn.step` with index ≥ 1 and its `turn.complete` close an update of its feed.
export const closeSubagentUpdate = (agentId: string, close: UpdateClose): Feed | undefined =>
  changeWatch(agentId, (watch) => ({ feed: closeUpdate(watch.feed, close) }))?.feed;

// §7.5: a finished review of a subagent moves that watchdog's cursor in the subagent's feed.
export const moveSubagentCursor = (agentId: string, slug: string, end: string): void => {
  changeWatch(agentId, (watch) => ({ feed: moveCursor(watch.feed, slug, end) }));
};

// §7.7 part 2 of a subagent review: the subagent's task. A batch that starts with the task row shows it in part
// 4, so part 2 then has no prompt.
export const taskPrompts = (watch: WatchedSubagent, rows: readonly FeedRow[]): number =>
  rows.some((row) => row.uuid === `${watch.agentId}${TASK_ROW}`) ? 0 : 1;

// §11.3: the subagent's `turn.complete` ends its loop: every note on it that waits is a late note now.
export const endSubagent = (agentId: string): void => {
  changeWatch(agentId, () => ({ isRunning: false }));
};

export const isSubagentRunning = (agentId: string): boolean => watchedSubagent(agentId)?.isRunning === true;

// §11.3: while the subagent runs, a note on it of any severity goes into it as a steer. Once it ended, no route
// here claims the note: it is a late note, and the primary agent's routes (§10) take it.
export const subagentRoute = (note: Note): DeliveryState | undefined =>
  note.subagent !== undefined && isSubagentRunning(note.subagent.agentId) ? 'steered' : undefined;

// §11.3: a held note that waits for its subagent's next tool result.
export const isSubagentSteer = (note: HeldNote): boolean =>
  note.delivery === 'steered' && subagentRoute(note) === 'steered';

// §11.3, §11.4: a note on a subagent whose loop ended is a late note: it goes to the primary agent.
export const isLateNote = (note: Note): boolean =>
  note.subagent !== undefined && !isSubagentRunning(note.subagent.agentId);

// §11.4: the subagent that a review agent reviews, from the slot that spawned it; none for the primary agent.
export const setReviewTarget = (reviewAgentId: string, subagent: string | undefined): void => {
  if (subagent === undefined) {
    live().reviews.delete(reviewAgentId);
  } else {
    live().reviews.set(reviewAgentId, subagent);
  }
};

export const subagentOfReview = (reviewAgentId: string | undefined): WatchedSubagent | undefined =>
  watchedSubagent(reviewAgentId === undefined ? undefined : live().reviews.get(reviewAgentId));

// §14.1: the watched subagents whose `$.state` copy is behind, each once.
export const takeDirtySubagents = (): WatchedSubagent[] => {
  const dirty = [...live().dirty].flatMap((agentId) => memory.watches.get(agentId) ?? []);
  memory.dirty.clear();
  return dirty;
};
