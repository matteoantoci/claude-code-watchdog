// §10.7, §10.8: the held notes that a delivery to the primary agent takes, in one wrapper. Pure: the delivery hooks
// call it.
import { watchdogBySlug } from '../agents/roster';
import { batchedOf, editsSince } from '../note/outdated';
import { currentTurn } from './turns';
import { wrapNotes, wrappedNote } from './wrapper';
import type { HeldNote } from '../note/notes';

// §10.7: held notes in one wrapper, each under its watchdog's name, with its age now; §10.8: each take counts the
// edits since the note's batch again.
export const wrapHeldNotes = (head: string, notes: readonly HeldNote[]): string =>
  wrapNotes(
    head,
    notes.map((note) =>
      wrappedNote(note, {
        name: watchdogBySlug(note.watchdog)?.name ?? note.watchdog,
        turn: currentTurn(),
        edits: editsSince(batchedOf(note)),
      })
    )
  );
