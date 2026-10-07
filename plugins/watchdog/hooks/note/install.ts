import { watchdogBySlug } from '../agents/roster';
import { addCard } from '../band/cards';
import { DEFAULT_MAX_NOTES_PER_REVIEW } from '../constants';
import { errorText } from '../errors';
import { currentLog, traceNote } from '../log/log';
import { isLateNote } from '../subagents/watch';
import { batchTextOf, noteOf } from './call';
import { UNSAFE_ROW, isUnsafeNote } from './destructive';
import { dropHeldNote } from './drop';
import { DROP_ACKS, judgeNote, normalizeNote, reviewSlots, setReviewSlots } from './guard';
import {
  EMPTY_HISTORY,
  changeLiveHistory,
  isRepeat,
  liveHistory,
  notesKey,
  readHistory,
  recordGuardKey,
  recordNote,
  setLiveHistory,
  updateNote,
  watchdogNotes,
} from './history';
import { deliveryFor, guardNote, heldNoteOf, holdNote, logRow, replaceHeldNote, watchHeldNotes } from './notes';
import { SUPERSEDED, retract, retractionOf } from './retract';
import type { OnEvents } from '../on';
import type { NoteCall } from './call';
import type { Verdict } from './guard';
import type { NoteHistory } from './history';
import type { HeldNote, Note } from './notes';
import type { ResolveCall } from './retract';
import type { Severity } from './tool';
import type { EngineInterface, MatchedHook, ToolCallResult } from 'claude-code';

type NoteHook = MatchedHook<'tool.call', { tool: 'mcp__watchdog__note' }>;

type ResolveHook = MatchedHook<'tool.call', { tool: 'mcp__watchdog__resolve' }>;

// §9.5: the ack of an admitted note.
const ADMITTED = 'Queued. Do not re-raise.';

// §9.6, §11.4: the live copy of `notes:<sessionId>` (or of a watched subagent's `notes:<sessionId>:<agentId>`)
// loads at the first note hook of a session id, so a new process, a hot reload and a session change each load it
// once. A load that another note finished first wins.
const loadHistory = async ($: EngineInterface, agentId?: string): Promise<string> => {
  const sessionId = await $.session.id();
  const stored =
    liveHistory(sessionId, agentId) === undefined ? await $.store.get(notesKey(sessionId, agentId)) : undefined;
  if (liveHistory(sessionId, agentId) === undefined) {
    setLiveHistory(sessionId, readHistory(stored), agentId);
  }
  return sessionId;
};

// §9.6, §14.2: write the live copy back with `lastUsed`. A refused write keeps the live copy; the store area
// shows it.
const saveHistory = async ($: EngineInterface, sessionId: string, agentId?: string): Promise<void> => {
  const lastUsed = await $.clock.now();
  const history: NoteHistory = { ...(liveHistory(sessionId, agentId) ?? EMPTY_HISTORY), lastUsed };
  setLiveHistory(sessionId, history, agentId);
  await $.store.set(notesKey(sessionId, agentId), history).catch(() => undefined);
};

// §9.1: the queued entry takes the higher severity in place, and the delivery state of that severity.
const raiseHeld = (history: NoteHistory, queued: HeldNote, severity: Severity) => {
  const raised = { ...queued, severity };
  const shown: HeldNote = { ...raised, delivery: deliveryFor(raised) };
  replaceHeldNote(queued, shown);
  const change = { key: normalizeNote(queued.text), severity, delivery: shown.delivery };
  return { shown, history: updateNote(history, queued.watchdog, change) };
};

// §9.4: the displaced note leaves the held list and the band, and the history and the review log mark it
// `displaced`.
const displaceHeld = (history: NoteHistory, note: Note, key: string | undefined): NoteHistory => {
  const gone = key === undefined ? undefined : heldNoteOf(note, key);
  if (gone === undefined || key === undefined) {
    return history;
  }
  dropHeldNote(gone);
  traceNote({ ...gone, delivery: 'displaced' });
  return updateNote(history, note.watchdog, { key, delivery: 'displaced' });
};

// §9.6: a new note waits in the held list and joins the history.
const holdNew = (history: NoteHistory, note: Note, displaced: string | undefined) => {
  const kept = displaceHeld(history, note, displaced);
  const shown: HeldNote = { ...note, delivery: deliveryFor(note) };
  holdNote(shown);
  addCard(shown);
  return {
    shown,
    history: recordNote(kept, note.watchdog, { text: note.text, severity: note.severity, delivery: shown.delivery }),
  };
};

// §9.2 to §9.4, §11.4: what the guard of the note's watchdog knows about the note's watched agent, and its
// verdict.
const judge = (history: NoteHistory, note: Note, key: string): Verdict =>
  judgeNote(
    { key, severity: note.severity },
    {
      seen: watchdogNotes(history, note.watchdog).keys.find((known) => known.key === key)?.severity,
      slots: reviewSlots(note.watchdog, note.agentId),
      budget: watchdogBySlug(note.watchdog)?.maxNotesPerReview ?? DEFAULT_MAX_NOTES_PER_REVIEW,
      pendingSeverity: (pending) => heldNoteOf(note, pending)?.severity,
    }
  );

// §9: an admitted note waits for its delivery, joins the live history of its watched agent and the review log,
// and writes one row; the ack.
const emitNote = ($: EngineInterface, sessionId: string, note: Note): string => {
  const key = normalizeNote(note.text);
  const history = liveHistory(sessionId, note.subagent?.agentId) ?? EMPTY_HISTORY;
  const queued = heldNoteOf(note, key);
  const verdict = judge(history, note, key);
  if (verdict.kind === 'dropped') {
    return DROP_ACKS[verdict.reason];
  }
  setReviewSlots(note.watchdog, note.agentId, verdict.slots);
  const next =
    verdict.kind === 'raised' && queued !== undefined
      ? raiseHeld(history, queued, note.severity)
      : holdNew(history, note, 'displaced' in verdict ? verdict.displaced : undefined);
  setLiveHistory(sessionId, next.history, note.subagent?.agentId);
  traceNote({ ...next.shown, agentId: note.agentId });
  $.ui.log(logRow(next.shown, watchdogBySlug(note.watchdog)?.name ?? note.watchdog));
  return ADMITTED;
};

// §11.4: a late note on a subagent goes to the primary agent, so it is first checked against the primary agent's
// key set. A repeat there is dropped; an admitted note records its key there too.
const isLateRepeat = async ($: EngineInterface, note: Note): Promise<boolean> => {
  const sessionId = isLateNote(note) ? await loadHistory($) : undefined;
  const entry = { key: normalizeNote(note.text), severity: note.severity };
  return sessionId !== undefined && isRepeat(liveHistory(sessionId) ?? EMPTY_HISTORY, note.watchdog, entry);
};

const keepLateKey = async ($: EngineInterface, sessionId: string, note: Note): Promise<void> => {
  const entry = { key: normalizeNote(note.text), severity: note.severity };
  setLiveHistory(sessionId, recordGuardKey(liveHistory(sessionId) ?? EMPTY_HISTORY, note.watchdog, entry));
  await saveHistory($, sessionId);
};

// §12.6: a note with a destructive command that its review's batch does not hold is dropped, with one row; then a
// guard of another area may drop it. The drop's ack, or undefined for a note that goes on to the emission guard.
const refusal = ($: EngineInterface, note: Note): ToolCallResult | undefined => {
  if (isUnsafeNote(note.text, batchTextOf(note.agentId))) {
    traceNote({ ...note, delivery: 'dropped:unsafe' });
    $.ui.log(UNSAFE_ROW);
    return { result: DROP_ACKS.unsafe };
  }
  const dropped = guardNote(note);
  return dropped === undefined ? undefined : { result: dropped };
};

// §8.3, §12.6, §9: a note of a known watchdog passes the destructive check first, then the guards of other
// areas, then the emission guard of its watched agent (§11.4); the history is written back after each
// admitted note.
const admitNote = async ($: EngineInterface, e: NoteCall): Promise<ToolCallResult> => {
  const note = noteOf(e);
  if ('deny' in note) {
    return note;
  }
  const refused = refusal($, note);
  if (refused !== undefined) {
    return refused;
  }
  const isLate = isLateNote(note);
  if (await isLateRepeat($, note)) {
    return { result: DROP_ACKS.duplicate };
  }
  const sessionId = await loadHistory($, note.subagent?.agentId);
  const ack = emitNote($, sessionId, note);
  if (ack === ADMITTED) {
    await saveHistory($, sessionId, note.subagent?.agentId);
  }
  if (ack === ADMITTED && isLate) {
    await keepLateKey($, sessionId, note);
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

// §10.8: a retraction drops the open note and writes one row; the history of the note's watched agent and the review
// log are written back. A refused write keeps the live copies; the store area shows a refused history write.
const retractNote = async ($: EngineInterface, e: ResolveCall): Promise<ToolCallResult> => {
  const asked = retractionOf(e);
  if (!('note' in asked)) {
    return asked;
  }
  const { note, reason } = asked;
  const sessionId = await loadHistory($, note.subagent?.agentId);
  const ack = retract(note, reason);
  $.ui.log(logRow({ ...note, delivery: SUPERSEDED }, watchdogBySlug(note.watchdog)?.name ?? note.watchdog));
  await saveHistory($, sessionId, note.subagent?.agentId);
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
  return { result: ack };
};

// §8.3, §10.8: the `resolve` hook answers like the `note` hook: without `next(e)`, and it catches every error.
const onResolve: ResolveHook = async ($, e) => {
  try {
    return await retractNote($, e);
  } catch (error) {
    return { deny: `The note was not retracted: ${errorText(error)}` };
  }
};

// §8.3: the `.catch` form of 2.1.290; it denies only a call from a watchdog agent or a fork. The tool
// names are literals so that `claude plugin validate` lists the matchers. §7.7, §9.6: the recap shows the state each
// held note has now (a new route, a delivery); the next write of the history keeps it.
export const installNote = (on: OnEvents<'tool.call'>): void => {
  on('tool.call', { tool: 'mcp__watchdog__note' }, onNote).catch((_$, e, next) =>
    next.called || next.origin.plugin !== 'watchdog' || e.agentId === undefined
      ? next(e)
      : { deny: 'The note was not recorded.' }
  );
  on('tool.call', { tool: 'mcp__watchdog__resolve' }, onResolve).catch((_$, e, next) =>
    next.called || next.origin.plugin !== 'watchdog' || e.agentId === undefined
      ? next(e)
      : { deny: 'The note was not retracted.' }
  );
  watchHeldNotes((_before, after) => {
    const change = { key: normalizeNote(after.text), delivery: after.delivery };
    changeLiveHistory(after.subagent?.agentId, (history) => updateNote(history, after.watchdog, change));
  });
};
