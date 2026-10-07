// §10.8: the open notes (each note that waits in the held list or shows on the band), their ids, and their
// retraction by a review agent of their watchdog. Pure: the review area's recap and the note area's `resolve` hook
// read it.
import { watchdogOf } from '../agents/ids';
import { cardKey, currentCards, removeCard } from '../band/cards';
import { NOTE_ID_DIGITS, NOTE_ID_RADIX } from '../constants';
import { fnv1a } from '../hash';
import { markLoggedNote } from '../log/log';
import { NOT_A_WATCHDOG } from './call';
import { dropHeldNote } from './drop';
import { normalizeNote } from './guard';
import { changeLiveHistory, forgetGuardKey, updateNote } from './history';
import { heldNotes } from './notes';
import { batchedOf, editsSince } from './outdated';
import { parseResolve } from './tool';
import type { Card } from '../band/cards';
import type { RecapNote } from './history';
import type { HeldNote, SubagentRef } from './notes';
import type { Severity } from './tool';
import type { MatchedHook } from 'claude-code';

export type ResolveCall = Parameters<MatchedHook<'tool.call', { tool: 'mcp__watchdog__resolve' }>>[1];

// §10.8, §13.2: the state of a retracted note.
export const SUPERSEDED = 'dropped:superseded';

// §10.8: the acks and the deny of a `resolve` call (build-session choice: short plain strings).
const RETRACTED = 'Retracted.';
const UNKNOWN_ID = 'Refused: no open note has this id.';
const NOT_YOURS = "Refused: this note is another watchdog's.";
const BAD_ARGUMENTS = 'A retraction needs the `id` of an open note and a `reason`.';

// §10.8: one open note: its id, its card key (§9.1), the review agent that sent it, its batch, and its entry in the
// held list (none for a delivered note whose card still shows).
export type OpenNote = {
  readonly id: string;
  readonly key: string;
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: Severity;
  readonly text: string;
  readonly batchEnd: string | null;
  readonly subagent?: SubagentRef;
  readonly held?: HeldNote;
};

// §10.8: a note's id is the hash of its card key (the watchdog, the watched agent and the normalized text, §9.1) in
// 4 base-36 digits. Nothing stores it, so the held list, the band, the recap and a reload agree on it.
export const noteId = (key: string): string =>
  (fnv1a(key) % NOTE_ID_RADIX ** NOTE_ID_DIGITS).toString(NOTE_ID_RADIX).padStart(NOTE_ID_DIGITS, '0');

// §10.8: a delivered note whose card still shows, as its card keeps it.
const openCard = (card: Card): OpenNote => ({
  id: noteId(card.key),
  key: card.key,
  watchdog: card.watchdog,
  agentId: card.agentId,
  severity: card.severity,
  text: card.text,
  batchEnd: card.batchEnd,
  ...(card.subagentId === undefined ? {} : { subagent: { agentId: card.subagentId, type: card.subagent ?? '' } }),
});

// §10.8: the open notes, oldest first: each held note, then each card whose note a delivery took.
const openNotes = (): OpenNote[] => {
  const held = heldNotes().map((note): OpenNote => ({
    id: noteId(cardKey(note)),
    key: cardKey(note),
    watchdog: note.watchdog,
    agentId: note.agentId,
    severity: note.severity,
    text: note.text,
    batchEnd: note.batchEnd,
    subagent: note.subagent,
    held: note,
  }));
  const keys = new Set(held.map((note) => note.key));
  return [
    ...held,
    ...currentCards()
      .filter((card) => !keys.has(card.key))
      .map(openCard),
  ];
};

// §7.7, §10.8: one recap note; an open one carries its id and the edits since its batch.
export type RecapEntry = RecapNote & { readonly open?: { readonly id: string; readonly edits: number } };

// §7.7, §10.8: the recap notes of the watchdog `slug` on one watched agent (`subagentId`, none for the primary
// agent). The newest entry of each open note's text carries its id and its mark.
export const recapEntries = (
  notes: readonly RecapNote[],
  slug: string,
  subagentId: string | undefined
): RecapEntry[] => {
  const open = new Map(
    openNotes()
      .filter((note) => note.watchdog === slug && note.subagent?.agentId === subagentId)
      .map((note) => [normalizeNote(note.text), note])
  );
  const newest = new Map(notes.map((note, index) => [normalizeNote(note.text), index]));
  return notes.map((note, index) => {
    const key = normalizeNote(note.text);
    const match = newest.get(key) === index ? open.get(key) : undefined;
    return match === undefined ? note : { ...note, open: { id: match.id, edits: editsSince(batchedOf(match)) } };
  });
};

// §8.3, §10.8: what a `resolve` call asks: the open note of the caller's watchdog that its `id` names, with the
// reason; else the ack that refuses an unknown id or another watchdog's note, or the deny of the main loop, an
// unknown agent and bad arguments.
export const retractionOf = (
  e: ResolveCall
): { readonly note: OpenNote; readonly reason: string } | { readonly result: string } | { readonly deny: string } => {
  const watchdog = watchdogOf(e.agentId);
  const input = parseResolve(e);
  if (watchdog === undefined || e.agentId === undefined) {
    return { deny: NOT_A_WATCHDOG };
  }
  if (input === undefined) {
    return { deny: BAD_ARGUMENTS };
  }
  const named = openNotes().filter((note) => note.id === input.id.trim());
  const own = named.find((note) => note.watchdog === watchdog);
  if (own !== undefined) {
    return { note: own, reason: input.reason };
  }
  return { result: named.length === 0 ? UNKNOWN_ID : NOT_YOURS };
};

// §10.8: a retraction drops the note as `dropped:superseded`. A held note leaves the held list, any note leaves the
// band; the record of the review that sent it (the dump, with the reason) and the recap show the state, and its key
// leaves the guard keys, so a later review may raise it again. The ack.
export const retract = (note: OpenNote, reason: string): string => {
  const key = normalizeNote(note.text);
  if (note.held === undefined) {
    removeCard(note.key);
  } else {
    dropHeldNote(note.held);
  }
  markLoggedNote(note.agentId, note.text, { delivery: SUPERSEDED, reason });
  changeLiveHistory(note.subagent?.agentId, (history) =>
    forgetGuardKey(updateNote(history, note.watchdog, { key, delivery: SUPERSEDED }), note.watchdog, key)
  );
  return RETRACTED;
};
