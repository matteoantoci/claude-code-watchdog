// §8.3, §12.6, §10.8: one `note` call of a review agent: its note, and the batch its review reads. Pure: the note
// hook reads it.
import { watchdogOf } from '../agents/ids';
import { currentTurn } from '../delivery/turns';
import { batchClose, batchRows, currentFeed } from '../feed/feed';
import { IDLE, reviewOf, slotOf } from '../review/slots';
import { subagentOfReview, watchedSubagent } from '../subagents/watch';
import { parseNote } from './tool';
import type { Feed } from '../feed/feed';
import type { Note } from './notes';
import type { MatchedHook } from 'claude-code';

export type NoteCall = Parameters<MatchedHook<'tool.call', { tool: 'mcp__watchdog__note' }>>[1];

// §8.3, §10.8: the deny of the `note` and `resolve` tools for the main loop and for an unknown agent.
export const NOT_A_WATCHDOG = 'Only watchdog agents can call this tool.';
const BAD_ARGUMENTS = 'A note needs `note` text and a `severity` of nit, concern or blocker.';

// §12.6, §10.8: the batch of the running review of this agent: the feed it reads (the primary agent's, or the
// reviewed subagent's, §11.2), its watchdog and its last row; none when no review of it runs.
const batchOf = (agentId: string): { feed: Feed; slug: string; end: string } | undefined => {
  const slug = reviewOf(agentId);
  const slot = slug === undefined ? IDLE : slotOf(slug);
  if (slug === undefined || slot.state !== 'reviewing') {
    return undefined;
  }
  const feed = slot.subagent === undefined ? currentFeed() : watchedSubagent(slot.subagent)?.feed;
  return feed === undefined ? undefined : { feed, slug, end: slot.batchEnd };
};

// §8.3: the note of a known watchdog, or the deny. §10.8: it keeps the edit count and the main-loop turn of its
// review's batch, else none and the turn of now (§10.7). §11.3: a note of a review of a subagent is on that subagent.
export const noteOf = (e: NoteCall): Note | { readonly deny: string } => {
  const watchdog = watchdogOf(e.agentId);
  if (watchdog === undefined || e.agentId === undefined) {
    return { deny: NOT_A_WATCHDOG };
  }
  const input = parseNote(e);
  const subagent = subagentOfReview(e.agentId);
  const batch = batchOf(e.agentId);
  const close = batch === undefined ? undefined : batchClose(batch.feed, batch.end);
  return input === undefined
    ? { deny: BAD_ARGUMENTS }
    : {
        watchdog,
        agentId: e.agentId,
        batchEdits: close?.edits ?? null,
        turn: close?.turn ?? currentTurn(),
        ...input,
        ...(subagent === undefined ? {} : { subagent: { agentId: subagent.agentId, type: subagent.type } }),
      };
};

// §12.6: the rendered rows that the mod gave the running review of this agent; none when no review of it runs.
export const batchTextOf = (agentId: string): string => {
  const batch = batchOf(agentId);
  return batch === undefined
    ? ''
    : batchRows(batch.feed, batch.slug, batch.end)
        .map((row) => row.text)
        .join('\n');
};
