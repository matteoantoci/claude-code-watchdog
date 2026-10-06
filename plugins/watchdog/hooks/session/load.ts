// §14.6: what a reload takes back from `$.state`. Pure: the session area's hook reads it.
import type { Feed } from '../feed/feed';

// §14.6: a reload keeps the feed. The on order of the load turned the session on again, with the roster read
// again and each cursor at the end; the rows and the updates that wait come back instead, each watchdog that
// reviewed before keeps its cursor, and a new one starts at the end.
export const resumeFeed = (stored: Feed, started: Feed): Feed => ({
  ...stored,
  cursors: Object.fromEntries(
    Object.keys(started.cursors).map((slug) => [
      slug,
      Object.hasOwn(stored.cursors, slug) ? (stored.cursors[slug] ?? null) : (stored.rows.at(-1)?.uuid ?? null),
    ])
  ),
});
