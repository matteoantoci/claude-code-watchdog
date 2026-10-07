// §10.8: the outdated mark of a note. Pure: the deliveries, the band and the recap read it.
import { currentFeed } from '../feed/feed';
import { watchedSubagent } from '../subagents/watch';
import type { Note } from './notes';

// §10.8: what the mark of a note reads: the last row of its review's batch (null when none was known) and, for a
// note on a subagent, that subagent's `agentId`. A band card has the same fields.
export type Batched = {
  readonly batchEnd: string | null;
  readonly subagentId?: string | undefined;
};

export const batchedOf = (note: Pick<Note, 'batchEnd' | 'subagent'>): Batched => ({
  batchEnd: note.batchEnd,
  subagentId: note.subagent?.agentId,
});

// §10.8: the edit rows of the watched agent's feed (the primary agent's, or the watched subagent's while the mod
// watches it) after the note's batch, whatever file they edit: the outdated mark when above 0. A batch end that
// left the feed lies before each row that stays (§7.1).
export const editsSince = (note: Batched): number => {
  const feed = note.subagentId === undefined ? currentFeed() : watchedSubagent(note.subagentId)?.feed;
  if (feed === undefined || note.batchEnd === null) {
    return 0;
  }
  const start = feed.rows.findIndex((row) => row.uuid === note.batchEnd) + 1;
  return feed.rows.slice(start).filter((row) => row.edit === true).length;
};

// §10.8, §13.1, §7.7: the mark as the card and the recap show it; none at 0.
export const outdatedMark = (edits: number): string | undefined =>
  edits > 0 ? `may be outdated: ${edits} ${edits === 1 ? 'edit' : 'edits'} since` : undefined;
