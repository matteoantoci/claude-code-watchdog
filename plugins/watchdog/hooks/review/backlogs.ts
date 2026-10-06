import { closeUpdate, currentFeed, moveCursor, pendingBatch, setFeed } from '../feed/feed';
import { closeSubagentUpdate, moveSubagentCursor, watchedSubagent, watchedSubagents } from '../subagents/watch';
import { cadenceOf } from './cadence';
import type { Watchdog } from '../agents/roster';
import type { Batch, Feed, UpdateClose } from '../feed/feed';
import type { WatchedSubagent } from '../subagents/watch';

// §7.5, §11.2: a backlog a watchdog may review: the primary agent's (no subagent) or a watched subagent's.
export type Backlog = { readonly subagent: WatchedSubagent | undefined; readonly batch: Batch };

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

// §7.2, §11.2: a boundary closes the update of its watched agent.
export const closeBacklog = (agentId: string | undefined, close: UpdateClose): void => {
  if (agentId === undefined) {
    setFeed(closeUpdate(currentFeed(), close));
  }
  rankLast(agentId === undefined ? currentFeed() : closeSubagentUpdate(agentId, close));
};

const rankOf = (backlog: Backlog): number => order.ranks.get(backlog.batch.updates[0]?.rows.at(-1)?.uuid ?? '') ?? 0;

const dueBatch = (feed: Feed, slug: string, subagent: string | undefined): Batch | undefined =>
  cadenceOf(cadenceKey(slug, subagent)).isDue ? pendingBatch(feed, slug) : undefined;

// §7.5: a free watchdog takes the backlog with the oldest update that waits, of the ones its cadence makes
// due; the primary agent's on a tie.
export const takeBacklog = (slug: string): Backlog | undefined => {
  const primary = dueBatch(currentFeed(), slug, undefined);
  const backlogs: Backlog[] = [
    ...(primary === undefined ? [] : [{ subagent: undefined, batch: primary }]),
    ...watchedSubagents()
      .filter((watch) => watch.watchdogs.includes(slug))
      .flatMap((watch) => {
        const batch = dueBatch(watch.feed, slug, watch.agentId);
        return batch === undefined ? [] : [{ subagent: watch, batch }];
      }),
  ];
  return backlogs.reduce<Backlog | undefined>(
    (oldest, backlog) => (oldest === undefined || rankOf(backlog) < rankOf(oldest) ? backlog : oldest),
    undefined
  );
};

// §7.1, §7.5: a finished review moves the cursor of its watchdog in the backlog it took. The ranks of the
// updates that left every feed go too.
export const moveBacklogCursor = (slug: string, subagent: string | undefined, end: string): void => {
  if (subagent === undefined) {
    setFeed(moveCursor(currentFeed(), slug, end));
  } else {
    moveSubagentCursor(subagent, slug, end);
  }
  const feeds = [currentFeed(), ...watchedSubagents().map((watch) => watch.feed)];
  const live = new Set(feeds.flatMap((feed) => feed.ends.map((close) => close.uuid)));
  [...order.ranks.keys()].filter((uuid) => !live.has(uuid)).forEach((uuid) => order.ranks.delete(uuid));
};
