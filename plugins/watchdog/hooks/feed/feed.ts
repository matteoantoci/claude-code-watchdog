import { isPending, orphanPiece, renderRow, serverToolPiece, settleCall } from './render';
import type { Piece, Settlement } from './render';
import type { PluginState, SessionAppendInput, TurnStepServerToolUse } from 'claude-code';

// §7.1, §7.5: the primary agent's feed (its shape is the `feed` key of the state contract). The backlog
// of a watchdog is the rows after its cursor, up to the last boundary; all of them merge into its next review.
export type Feed = PluginState['watchdog']['feed'];

export type FeedRow = Feed['rows'][number];

export type UpdateClose = Feed['ends'][number]['close'];

// §7.5: one update of a batch: its rows and how its boundary closed it.
export type Update = { readonly rows: readonly FeedRow[]; readonly close: UpdateClose };

export type Batch = { readonly rows: readonly FeedRow[]; readonly end: string; readonly updates: readonly Update[] };

export const EMPTY_FEED: Feed = { rows: [], ends: [], cursors: {}, prompts: 0 };

// §5.2 step 3: `/watchdog on` moves each cursor to the end, so no earlier row is replayed.
export const startFeed = (slugs: readonly string[]): Feed => ({
  ...EMPTY_FEED,
  cursors: Object.fromEntries(slugs.map((slug) => [slug, null])),
});

type Settled = { readonly rows: readonly FeedRow[]; readonly orphans: readonly Piece[] };

// §7.6: a tool result joins the pending row of its call; a result whose call the feed lacks is a row of its own.
const settleInto = (settled: Settled, settlement: Settlement): Settled => {
  const at = settled.rows.findLastIndex((row) => row.call === settlement.id && isPending(row));
  const row = settled.rows[at];
  return row === undefined
    ? { ...settled, orphans: [...settled.orphans, orphanPiece(settlement)] }
    : { ...settled, rows: settled.rows.with(at, { ...row, ...settleCall(row, settlement) }) };
};

// §7.1, §7.6: one `session.append` row enters the feed rendered. A row with several pieces keeps its uuid on
// the first; §7.7: a person prompt counts.
export const recordRow = (feed: Feed, row: SessionAppendInput): Feed => {
  const rendered = renderRow(row);
  const settled = rendered.settlements.reduce(settleInto, { rows: feed.rows, orphans: [] });
  const pieces = [...settled.orphans, ...rendered.pieces];
  return {
    ...feed,
    rows: [
      ...settled.rows,
      ...pieces.map((piece, index) => Object.assign({ uuid: index === 0 ? row.uuid : `${row.uuid}#${index}` }, piece)),
    ],
    prompts: feed.prompts + (rendered.isPersonPrompt ? 1 : 0),
  };
};

// §7.6: the server tool calls of a main-loop step that no row named.
export const addServerToolUses = (feed: Feed, uses: readonly TurnStepServerToolUse[]): Feed => {
  const known = new Set(feed.rows.flatMap((row) => row.call ?? []));
  const added = uses
    .filter((use) => !known.has(use.id))
    .map((use) => Object.assign({ uuid: `server-tool:${use.id}` }, serverToolPiece(use)));
  return added.length === 0 ? feed : { ...feed, rows: [...feed.rows, ...added] };
};

// §7.2: a boundary closes the update that the rows since the last boundary make. A turn end right after a
// step boundary, with no row between them, closes that update again as the turn end (§7.5 markers).
export const closeUpdate = (feed: Feed, close: UpdateClose): Feed => {
  const last = feed.rows.at(-1)?.uuid;
  const isSameEnd = feed.ends.at(-1)?.uuid === last;
  if (last === undefined || (isSameEnd && close === 'step')) {
    return feed;
  }
  return {
    ...feed,
    ends: isSameEnd
      ? feed.ends.with(feed.ends.length - 1, { uuid: last, close })
      : [...feed.ends, { uuid: last, close }],
  };
};

// The index of the row just after `uuid`; 0 for no uuid or an unknown one.
const indexAfter = (feed: Feed, uuid: string | null | undefined): number =>
  feed.rows.findIndex((row) => row.uuid === uuid) + 1;

// The rows after a watchdog's cursor up to `end`: the batch a review of it gets while the cursor waits
// (§7.5, §12.6).
export const batchRows = (feed: Feed, slug: string, end: string | undefined): readonly FeedRow[] =>
  feed.rows.slice(indexAfter(feed, feed.cursors[slug]), indexAfter(feed, end));

// §7.5: the batch split at its boundaries, oldest update first.
const splitUpdates = (feed: Feed, rows: readonly FeedRow[]): Update[] => {
  const closes = new Map(feed.ends.map((end) => [end.uuid, end.close]));
  const ends = rows.flatMap((row, index) => {
    const close = closes.get(row.uuid);
    return close === undefined ? [] : [{ index, close }];
  });
  return ends.map((end, n) => ({ rows: rows.slice((ends[n - 1]?.index ?? -1) + 1, end.index + 1), close: end.close }));
};

// §7.5: every update that waits for one watchdog, merged into one batch; undefined when none waits.
export const backlogBatch = (feed: Feed, slug: string): Batch | undefined => {
  const end = feed.ends.at(-1)?.uuid;
  const rows = batchRows(feed, slug, end);
  return end === undefined || rows.length === 0 ? undefined : { rows, end, updates: splitUpdates(feed, rows) };
};

// §7.7 part 3: the tool calls after a watchdog's cursor (its new updates and later ones); the recap leaves
// them out of the older updates.
export const unreviewedCalls = (feed: Feed, slug: string): ReadonlySet<string> =>
  new Set(feed.rows.slice(indexAfter(feed, feed.cursors[slug])).flatMap((row) => row.call ?? []));

// §7.1: a finished review moves its watchdog's cursor; the rows behind the oldest cursor go.
export const moveCursor = (feed: Feed, slug: string, end: string): Feed => {
  const cursors = { ...feed.cursors, [slug]: end };
  const keep = Math.min(...Object.values(cursors).map((uuid) => Math.max(indexAfter(feed, uuid) - 1, 0)));
  const rows = feed.rows.slice(keep);
  return { ...feed, rows, ends: feed.ends.filter((close) => rows.some((row) => row.uuid === close.uuid)), cursors };
};

// The live feed in module memory; `$.state` key `feed` keeps a copy (§14.1).
const memory: { feed: Feed } = { feed: EMPTY_FEED };

export const currentFeed = (): Feed => memory.feed;

export const setFeed = (feed: Feed): void => {
  memory.feed = feed;
};
