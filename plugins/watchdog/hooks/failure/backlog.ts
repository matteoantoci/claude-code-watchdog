import { moveCursor, pendingBatch } from '../feed/feed';
import type { Feed } from '../feed/feed';

// §7.5, §12.3: what an outcome does to the backlog of its watchdog. `move`: the cursor passes the batch of the
// review. `keep`: the batch waits at the front and merges into the next review. `drop`: the whole backlog
// goes (a halt). `forget`: the watchdog leaves the feed until `/watchdog on` starts it again.
export type Backlog = 'move' | 'keep' | 'drop' | 'forget';

export const applyBacklog = (feed: Feed, cursor: { slug: string; batchEnd: string }, backlog: Backlog): Feed => {
  const { slug } = cursor;
  if (backlog === 'move') {
    return moveCursor(feed, slug, cursor.batchEnd);
  }
  if (backlog === 'drop') {
    const waiting = pendingBatch(feed, slug);
    return waiting === undefined ? feed : moveCursor(feed, slug, waiting.end);
  }
  if (backlog === 'forget') {
    return { ...feed, cursors: Object.fromEntries(Object.entries(feed.cursors).filter(([key]) => key !== slug)) };
  }
  return feed;
};
