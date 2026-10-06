import type { PluginState } from 'claude-code';

// §7.1, §7.5: the primary agent's feed (its shape is the `feed` key of the state contract). The backlog
// of a watchdog is the rows after its cursor, up to the last boundary; all of them merge into its next review.
export type Feed = PluginState['watchdog']['feed'];

export type FeedRow = Feed['rows'][number];

export type Batch = { readonly rows: readonly FeedRow[]; readonly end: string };

export const EMPTY_FEED: Feed = { rows: [], ends: [], cursors: {} };

// §5.2 step 3: `/watchdog on` moves each cursor to the end, so no earlier row is replayed.
export const startFeed = (slugs: readonly string[]): Feed => ({
  rows: [],
  ends: [],
  cursors: Object.fromEntries(slugs.map((slug) => [slug, null])),
});

export const addRow = (feed: Feed, row: FeedRow): Feed => ({ ...feed, rows: [...feed.rows, row] });

// §7.2: a boundary closes the update that the rows since the last boundary make.
export const closeUpdate = (feed: Feed): Feed => {
  const last = feed.rows.at(-1)?.uuid;
  return last === undefined || feed.ends.at(-1) === last ? feed : { ...feed, ends: [...feed.ends, last] };
};

// The index of the row just after `uuid`; 0 for no uuid or an unknown one.
const indexAfter = (feed: Feed, uuid: string | null | undefined): number =>
  feed.rows.findIndex((row) => row.uuid === uuid) + 1;

// The rows after a watchdog's cursor up to `end`: the batch a review of it gets while the cursor waits
// (§7.5, §12.6).
export const batchRows = (feed: Feed, slug: string, end: string | undefined): readonly FeedRow[] =>
  feed.rows.slice(indexAfter(feed, feed.cursors[slug]), indexAfter(feed, end));

// §7.5: every update that waits for one watchdog, merged into one batch; undefined when none waits.
export const pendingBatch = (feed: Feed, slug: string): Batch | undefined => {
  const end = feed.ends.at(-1);
  const rows = batchRows(feed, slug, end);
  return end === undefined || rows.length === 0 ? undefined : { rows, end };
};

// §7.1: a finished review moves its watchdog's cursor; the rows behind the oldest cursor go.
export const moveCursor = (feed: Feed, slug: string, end: string): Feed => {
  const cursors = { ...feed.cursors, [slug]: end };
  const keep = Math.min(...Object.values(cursors).map((uuid) => Math.max(indexAfter(feed, uuid) - 1, 0)));
  const rows = feed.rows.slice(keep);
  return { rows, ends: feed.ends.filter((uuid) => rows.some((row) => row.uuid === uuid)), cursors };
};

// The live feed in module memory; `$.state` key `feed` keeps a copy (§14.1).
const memory: { feed: Feed } = { feed: EMPTY_FEED };

export const currentFeed = (): Feed => memory.feed;

export const setFeed = (feed: Feed): void => {
  memory.feed = feed;
};
