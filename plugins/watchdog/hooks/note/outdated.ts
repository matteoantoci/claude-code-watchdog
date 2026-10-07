// §10.8: outdated notes: the mark and the fate of a note at a later review. Pure: the note hooks, the deliveries and
// the band read it.
import { currentFeed } from '../feed/feed';
import { watchedSubagent } from '../subagents/watch';
import { normalizeNote } from './guard';
import type { Feed } from '../feed/feed';
import type { Note } from './notes';

// §10.8: what the mark of a note reads: its text, the last row of its review's batch (null when none was known)
// and, for a note on a subagent, that subagent's `agentId`. A band card has the same fields.
export type Batched = {
  readonly text: string;
  readonly batchEnd: string | null;
  readonly subagentId?: string | undefined;
};

export const batchedOf = (note: Note): Batched => ({
  text: note.text,
  batchEnd: note.batchEnd,
  subagentId: note.subagent?.agentId,
});

// Characters that `RegExp` reads as syntax.
const SYNTAX = /[.*+?^${}()|[\]\\/]/gu;

// §10.8: the note names the file of `path`: its base name stands in the text on its own, alone or at the end of a
// path. A name inside a longer name (`mycart.py`, `cart.py.bak`, `cart.pyc`) does not count.
export const isNamed = (text: string, path: string): boolean => {
  const name = path.split(/[/\\]/u).at(-1) ?? '';
  const escaped = name.replaceAll(SYNTAX, String.raw`\$&`);
  return (
    name !== '' &&
    new RegExp(String.raw`(?<![\p{L}\p{N}_.-])${escaped}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`, 'u').test(text)
  );
};

// §10.8: the feed of a watched agent: the primary agent's (no subagent), or the watched subagent's while the mod
// watches it.
export const watchedFeed = (subagentId: string | undefined): Feed | undefined =>
  subagentId === undefined ? currentFeed() : watchedSubagent(subagentId)?.feed;

// §10.8: the places in `feed` of the edit calls after the note's batch whose file the note names. A batch end that
// left the feed lies before each row that stays: rows leave only from the front (§7.1).
const editsAt = (feed: Feed, note: Batched): number[] => {
  const start =
    note.batchEnd === null ? feed.rows.length : feed.rows.findIndex((row) => row.uuid === note.batchEnd) + 1;
  return feed.rows.flatMap((row, index) =>
    index >= start && row.edit !== undefined && isNamed(note.text, row.edit) ? [index] : []
  );
};

// §10.8: the edits since the note's batch on a file the note names: the outdated mark when above 0.
export const editsSince = (note: Batched): number => {
  const feed = watchedFeed(note.subagentId);
  return feed === undefined ? 0 : editsAt(feed, note).length;
};

// §10.8: the normalized texts of the note calls of each watchdog's newest review (slug → its agent and keys), so
// that its end can tell a repeat. A call of a new review agent starts the list again.
const calls = new Map<string, { readonly agentId: string; readonly keys: ReadonlySet<string> }>();

export const recordNoteCall = (note: Pick<Note, 'watchdog' | 'agentId' | 'text'>): void => {
  const known = calls.get(note.watchdog);
  const keys = known?.agentId === note.agentId ? known.keys : [];
  calls.set(note.watchdog, { agentId: note.agentId, keys: new Set([...keys, normalizeNote(note.text)]) });
};

// §10.8: a review of a watchdog that ended with an answer: its agent, its watchdog slug, the subagent it reviewed
// (none for the primary agent) and the last row of its batch.
export type LaterReview = {
  readonly agentId: string;
  readonly slug: string;
  readonly subagentId: string | undefined;
  readonly batchEnd: string;
};

// §10.8: what a later review of the note's watchdog on its watched agent does to the note. `keep`: no edit since the
// note's batch names its file, or the review's batch does not reach each such edit. Else `renew` (the note takes the
// review's batch) when the review sent the note's text again, whatever the guard did with it, and `supersede` when
// it did not.
export const fateOf = (note: Batched, review: LaterReview): 'keep' | 'renew' | 'supersede' => {
  const feed = watchedFeed(note.subagentId);
  const edits = feed === undefined ? [] : editsAt(feed, note);
  const end = feed?.rows.findIndex((row) => row.uuid === review.batchEnd) ?? -1;
  if (edits.length === 0 || edits.some((at) => at > end)) {
    return 'keep';
  }
  const known = calls.get(review.slug);
  const isRepeat = known?.agentId === review.agentId && known.keys.has(normalizeNote(note.text));
  return isRepeat ? 'renew' : 'supersede';
};
