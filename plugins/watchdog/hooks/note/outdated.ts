// §10.8: the outdated mark of a note. Pure: the deliveries, the band and the recap read it.
import { currentFeed } from '../feed/feed';
import { watchedSubagent } from '../subagents/watch';
import type { Note } from './notes';

// §10.8: what the mark of a note reads: the edit count of its review's batch (null when none was known) and, for a
// note on a subagent, that subagent's `agentId`. A band card has the same fields.
export type Batched = {
  readonly batchEdits: number | null;
  readonly subagentId?: string | undefined;
};

export const batchedOf = (note: Pick<Note, 'batchEdits' | 'subagent'>): Batched => ({
  batchEdits: note.batchEdits,
  subagentId: note.subagent?.agentId,
});

// §10.8: the edit calls of the watched agent (the primary agent, or the watched subagent while the mod watches it)
// since the note's batch, whatever file they edit: the outdated mark when above 0. The feed counts the rows it
// dropped too (§7.1); a feed that started again (§5.2, §14.3) counts no edit of before.
export const editsSince = (note: Batched): number => {
  const feed = note.subagentId === undefined ? currentFeed() : watchedSubagent(note.subagentId)?.feed;
  return feed === undefined || note.batchEdits === null ? 0 : Math.max(feed.edits - note.batchEdits, 0);
};

// §10.8, §13.1, §7.7: the mark as the card and the recap show it; none at 0.
export const outdatedMark = (edits: number): string | undefined =>
  edits > 0 ? `may be outdated: ${edits} ${edits === 1 ? 'edit' : 'edits'} since` : undefined;
