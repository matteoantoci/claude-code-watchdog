// §7.5: the backlog that a `-p` run leaves unreviewed. Pure: the review and dump hooks apply it.
import { moveCursor } from '../feed/feed';
import type { Feed } from '../feed/feed';

// §7.5, §10.6: `-p` unbinds the session when its last background task ends; a spawn then rejects with this.
export const isUnboundReject = (reason: string): boolean => reason.includes('no session is bound');

// §7.5: the closed updates after `from`: a watchdog's cursor, or the end of the batch that its running review
// took. A null or unknown `from` counts every update.
export const waitingUpdates = (feed: Feed, from: string | null | undefined): number => {
  const start = feed.rows.findIndex((row) => row.uuid === from);
  return feed.ends.filter((end) => feed.rows.findIndex((row) => row.uuid === end) > start).length;
};

// §7.5: the backlog goes: the watchdog's cursor moves past the last closed update.
export const dropBacklog = (feed: Feed, slug: string): Feed => {
  const end = feed.ends.at(-1);
  return end === undefined ? feed : moveCursor(feed, slug, end);
};
