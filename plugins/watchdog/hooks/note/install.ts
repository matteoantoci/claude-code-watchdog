import { watchdogOf } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { DEFAULT_MAX_NOTES_PER_REVIEW } from '../constants';
import { currentTurn } from '../delivery/turns';
import { errorText } from '../errors';
import { batchRows, currentFeed } from '../feed/feed';
import { traceNote } from '../log/log';
import { reviewOf, slotOf } from '../review/slots';
import { UNSAFE_ROW, isUnsafeNote } from './destructive';
import { DROP_ACKS, judgeNote, normalizeNote, reviewSlots, setReviewSlots } from './guard';
import {
  EMPTY_HISTORY,
  claimErrorRow,
  liveHistory,
  notesKey,
  readHistory,
  recordNote,
  setLiveHistory,
  updateNote,
  watchdogNotes,
} from './history';
import { deliveryFor, guardNote, heldNoteOf, holdNote, logRow, replaceHeldNote } from './notes';
import { parseNote } from './tool';
import type { OnEvents } from '../on';
import type { Verdict } from './guard';
import type { NoteHistory } from './history';
import type { HeldNote, Note } from './notes';
import type { Severity } from './tool';
import type { EngineInterface, MatchedHook, ToolCallResult } from 'claude-code';

type NoteHook = MatchedHook<'tool.call', { tool: 'mcp__watchdog__note' }>;
type NoteCall = Parameters<NoteHook>[1];

// §8.3: the deny for the main loop and for an unknown agent; §9.5: the ack of an admitted note.
const NOT_A_WATCHDOG = 'Only watchdog agents can call this tool.';
const ADMITTED = 'Queued. Do not re-raise.';
const BAD_ARGUMENTS = 'A note needs `note` text and a `severity` of nit, concern or blocker.';

// §8.3: the note of a known watchdog, with the main-loop turn when it came (§10.7), or the deny.
const noteOf = (e: NoteCall): Note | { readonly deny: string } => {
  const watchdog = watchdogOf(e.agentId);
  if (watchdog === undefined || e.agentId === undefined) {
    return { deny: NOT_A_WATCHDOG };
  }
  const input = parseNote(e);
  return input === undefined
    ? { deny: BAD_ARGUMENTS }
    : { watchdog, agentId: e.agentId, turn: currentTurn(), ...input };
};

// §12.6: the rendered rows that the mod gave the running review of this agent; none when no review of it runs.
const batchTextOf = (agentId: string): string => {
  const slug = reviewOf(agentId);
  const slot = slug === undefined ? undefined : slotOf(slug);
  return slug === undefined || slot?.state !== 'reviewing'
    ? ''
    : batchRows(currentFeed(), slug, slot.batchEnd)
        .map((row) => row.text)
        .join('\n');
};

// §9.6: the live copy of `notes:<sessionId>` loads at the first note hook of a session id, so a new
// process, a hot reload and a session change each load it once. A load that another note finished first wins.
const loadHistory = async ($: EngineInterface): Promise<string> => {
  const sessionId = await $.session.id();
  const stored = liveHistory(sessionId) === undefined ? await $.store.get(notesKey(sessionId)) : undefined;
  if (liveHistory(sessionId) === undefined) {
    setLiveHistory(sessionId, readHistory(stored));
  }
  return sessionId;
};

// §9.6, §14.2: write the live copy back with `lastUsed`. A refused write keeps the live copy and shows one
// row for each session.
const saveHistory = async ($: EngineInterface, sessionId: string): Promise<void> => {
  const lastUsed = await $.clock.now();
  const history: NoteHistory = { ...(liveHistory(sessionId) ?? EMPTY_HISTORY), lastUsed };
  setLiveHistory(sessionId, history);
  await $.store.set(notesKey(sessionId), history).catch((error: unknown) => {
    if (claimErrorRow()) {
      $.ui.log(`watchdog: the note history was not saved: ${errorText(error)}`);
    }
  });
};

// §9.1: the queued entry takes the higher severity in place, and the delivery state of that severity.
const raiseHeld = (history: NoteHistory, queued: HeldNote, severity: Severity) => {
  const raised = { ...queued, severity };
  const shown: HeldNote = { ...raised, delivery: deliveryFor(raised) };
  replaceHeldNote(queued, shown);
  const change = { key: normalizeNote(queued.text), severity, delivery: shown.delivery };
  return { shown, history: updateNote(history, queued.watchdog, change) };
};

// §9.4: the displaced note leaves the held list, and the history and the review log mark it `displaced`.
const displaceHeld = (history: NoteHistory, watchdog: string, key: string | undefined): NoteHistory => {
  const gone = key === undefined ? undefined : heldNoteOf(watchdog, key);
  if (gone === undefined || key === undefined) {
    return history;
  }
  replaceHeldNote(gone);
  traceNote({ ...gone, delivery: 'displaced' });
  return updateNote(history, watchdog, { key, delivery: 'displaced' });
};

// §9.6: a new note waits in the held list and joins the history.
const holdNew = (history: NoteHistory, note: Note, displaced: string | undefined) => {
  const kept = displaceHeld(history, note.watchdog, displaced);
  const shown: HeldNote = { ...note, delivery: deliveryFor(note) };
  holdNote(shown);
  return {
    shown,
    history: recordNote(kept, note.watchdog, { text: note.text, severity: note.severity, delivery: shown.delivery }),
  };
};

// §9.2 to §9.4: what the guard of the note's watchdog knows, and its verdict.
const judge = (history: NoteHistory, note: Note, key: string): Verdict =>
  judgeNote(
    { key, severity: note.severity },
    {
      seen: watchdogNotes(history, note.watchdog).keys.find((known) => known.key === key)?.severity,
      slots: reviewSlots(note.watchdog, note.agentId),
      budget: watchdogBySlug(note.watchdog)?.maxNotesPerReview ?? DEFAULT_MAX_NOTES_PER_REVIEW,
      pendingSeverity: (pending) => heldNoteOf(note.watchdog, pending)?.severity,
    }
  );

// §9: an admitted note waits for its delivery, joins the live history and the review log, and writes one
// row; the ack.
const emitNote = ($: EngineInterface, sessionId: string, note: Note): string => {
  const key = normalizeNote(note.text);
  const history = liveHistory(sessionId) ?? EMPTY_HISTORY;
  const queued = heldNoteOf(note.watchdog, key);
  const verdict = judge(history, note, key);
  if (verdict.kind === 'dropped') {
    return DROP_ACKS[verdict.reason];
  }
  setReviewSlots(note.watchdog, note.agentId, verdict.slots);
  const next =
    verdict.kind === 'raised' && queued !== undefined
      ? raiseHeld(history, queued, note.severity)
      : holdNew(history, note, 'displaced' in verdict ? verdict.displaced : undefined);
  setLiveHistory(sessionId, next.history);
  traceNote({ ...next.shown, agentId: note.agentId });
  $.ui.log(logRow(next.shown, watchdogBySlug(note.watchdog)?.name ?? note.watchdog));
  return ADMITTED;
};

// §8.3, §12.6, §9: a note of a known watchdog passes the destructive check first, then the guards of other
// areas, then the emission guard; the history is written back after each admitted note.
const admitNote = async ($: EngineInterface, e: NoteCall): Promise<ToolCallResult> => {
  const note = noteOf(e);
  if ('deny' in note) {
    return note;
  }
  if (isUnsafeNote(note.text, batchTextOf(note.agentId))) {
    traceNote({ ...note, delivery: 'dropped:unsafe' });
    $.ui.log(UNSAFE_ROW);
    return { result: DROP_ACKS.unsafe };
  }

  const dropped = guardNote(note);
  if (dropped !== undefined) {
    return { result: dropped };
  }
  const sessionId = await loadHistory($);
  const ack = emitNote($, sessionId, note);
  if (ack === ADMITTED) {
    await saveHistory($, sessionId);
  }
  return { result: ack };
};

// §8.3: the hook answers without `next(e)`, so no permission check runs; it catches every error, because
// a throw opens a permission dialog in front of the person.
const onNote: NoteHook = async ($, e) => {
  try {
    return await admitNote($, e);
  } catch (error) {
    return { deny: `The note was not recorded: ${errorText(error)}` };
  }
};

// §8.3: the `.catch` form of 2.1.290; it denies only a call from a watchdog agent or a fork. The tool
// name is a literal so that `claude plugin validate` lists the matcher.
export const installNote = (on: OnEvents<'tool.call'>): void => {
  on('tool.call', { tool: 'mcp__watchdog__note' }, onNote).catch((_$, e, next) =>
    next.called || next.origin.plugin !== 'watchdog' || e.agentId === undefined
      ? next(e)
      : { deny: 'The note was not recorded.' }
  );
};
