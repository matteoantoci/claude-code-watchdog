import { currentTurn } from '../delivery/turns';
import { closeUpdate, currentFeed, backlogBatch, setFeed } from '../feed/feed';
import { changeSubagentFeed, closeSubagentUpdate, watchedSubagent, watchedSubagents } from '../subagents/watch';
import { cadenceOf } from './cadence';
import type { Watchdog } from '../agents/roster';
import type { Batch, Feed, UpdateClose } from '../feed/feed';
import type { WatchedSubagent } from '../subagents/watch';
import type { Start } from './slots';

// §7.5, §11.2: a backlog a watchdog may review: the primary agent's (no subagent) or a watched subagent's.
export type Backlog = { readonly subagent: WatchedSubagent | undefined; readonly batch: Batch };

// §7.5, §11.2: the feed of each watched agent, which holds a backlog for each of its watchdogs: the primary
// agent's (no subagent), then each watched subagent's.
export const watchedFeeds = (): { readonly subagent: WatchedSubagent | undefined; readonly feed: Feed }[] => [
  { subagent: undefined, feed: currentFeed() },
  ...watchedSubagents().map((watch) => ({ subagent: watch, feed: watch.feed })),
];

// §7.4, §11.2: the cadence of one pair of a watchdog and a watched agent; the primary agent's pair is the slug.
export const cadenceKey = (slug: string, subagent: string | undefined): string =>
  subagent === undefined ? slug : `${slug}@${subagent}`;

// §7.5: the order in which the updates closed across all watched agents (the last row of an update → its
// rank), so that a free watchdog takes the backlog whose oldest update waits longest.
const order = { next: 1, ranks: new Map<string, number>() };

const rankLast = (feed: Feed | undefined): void => {
  const end = feed?.ends.at(-1)?.uuid;
  if (end !== undefined && !order.ranks.has(end)) {
    order.ranks.set(end, order.next);
    order.next += 1;
  }
};

// §7.2, §11.2: the watchdogs that a boundary of this loop counts for: the roster for the primary agent, the
// listed ones for a watched subagent; undefined for any other loop.
export const watchersOf = (
  agentId: string | undefined,
  roster: readonly Watchdog[]
): readonly Watchdog[] | undefined => {
  const watch = watchedSubagent(agentId);
  if (agentId === undefined || watch === undefined) {
    return agentId === undefined ? roster : undefined;
  }
  return roster.filter((watchdog) => watch.watchdogs.includes(watchdog.slug));
};

// §7.2, §11.2: a boundary closes the update of its watched agent; §10.8: at the main-loop turn counter of now.
export const closeBacklog = (agentId: string | undefined, close: UpdateClose): void => {
  if (agentId === undefined) {
    setFeed(closeUpdate(currentFeed(), close, currentTurn()));
  }
  rankLast(agentId === undefined ? currentFeed() : closeSubagentUpdate(agentId, close, currentTurn()));
};

const rankOf = (backlog: Backlog): number => order.ranks.get(backlog.batch.updates[0]?.rows.at(-1)?.uuid ?? '') ?? 0;

// §7.4, §12.3: whether a review that starts this way takes from this backlog: a boundary review a due one, a try
// any one, the compact retry only the backlog of the review it repeats.
const isTaken = (slug: string, subagent: string | undefined, start: Start): boolean => {
  if (start.isCompact === true) {
    return subagent === start.subagent;
  }
  return start.from !== undefined || cadenceOf(cadenceKey(slug, subagent)).isDue;
};

// §7.5: a free watchdog takes the backlog with the oldest update that waits, of the ones it may take now; the
// primary agent's on a tie.
export const takeBacklog = (slug: string, start: Start): Backlog | undefined => {
  const sources = watchedFeeds().filter(({ subagent }) => subagent === undefined || subagent.watchdogs.includes(slug));
  const backlogs = sources.flatMap(({ subagent, feed }) => {
    const batch = isTaken(slug, subagent?.agentId, start) ? backlogBatch(feed, slug) : undefined;
    return batch === undefined ? [] : [{ subagent, batch }];
  });
  return backlogs.reduce<Backlog | undefined>(
    (oldest, backlog) => (oldest === undefined || rankOf(backlog) < rankOf(oldest) ? backlog : oldest),
    undefined
  );
};

// §7.1, §7.5, §12.3: the outcome of a review changes the backlog it took: the primary agent's feed or a watched
// subagent's. The ranks of the updates that left every feed go too.
export const changeBacklog = (subagent: string | undefined, change: (feed: Feed) => Feed): void => {
  if (subagent === undefined) {
    setFeed(change(currentFeed()));
  } else {
    changeSubagentFeed(subagent, change);
  }
  const live = new Set(watchedFeeds().flatMap(({ feed }) => feed.ends.map((close) => close.uuid)));
  [...order.ranks.keys()].filter((uuid) => !live.has(uuid)).forEach((uuid) => order.ranks.delete(uuid));
};
