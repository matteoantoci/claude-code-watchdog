import { NOTE_KEY_CAP, RECAP_NOTE_CAP } from '../constants';
import { normalizeNote } from './guard';
import { isDeliveryState } from './notes';
import { isSeverity } from './tool';
import type { DeliveryState } from './notes';
import type { Severity } from './tool';

// §9.2: a normalized note text and the highest severity the watchdog sent it at.
export type GuardKey = { readonly key: string; readonly severity: Severity };

// §7.7: one note in full for the recap.
export type RecapNote = { readonly text: string; readonly severity: Severity; readonly delivery: DeliveryState };

// §14.2: the history of one watchdog, oldest first.
export type WatchdogNotes = { readonly keys: readonly GuardKey[]; readonly notes: readonly RecapNote[] };

// §9.6, §14.2: the value of the `$.store` key `notes:<sessionId>`: each watchdog slug's history, and the
// time of the last write (ms since the epoch) for the store prune.
export type NoteHistory = { readonly watchdogs: Readonly<Record<string, WatchdogNotes>>; readonly lastUsed: number };

export const EMPTY_HISTORY: NoteHistory = { watchdogs: {}, lastUsed: 0 };

const NO_NOTES: WatchdogNotes = { keys: [], notes: [] };

export const notesKey = (sessionId: string): string => `notes:${sessionId}`;

export const watchdogNotes = (history: NoteHistory, slug: string): WatchdogNotes => history.watchdogs[slug] ?? NO_NOTES;

const withNotes = (history: NoteHistory, slug: string, notes: WatchdogNotes): NoteHistory => ({
  ...history,
  watchdogs: { ...history.watchdogs, [slug]: notes },
});

// §14.2: a key keeps its place when its severity rises; a new key goes last and the oldest leave at the cap.
const recordKey = (keys: readonly GuardKey[], entry: GuardKey): readonly GuardKey[] =>
  keys.some((known) => known.key === entry.key)
    ? keys.map((known) => (known.key === entry.key ? entry : known))
    : [...keys, entry].slice(-NOTE_KEY_CAP);

// §9.6: an admitted note records its key and joins the newest 20 notes.
export const recordNote = (history: NoteHistory, slug: string, note: RecapNote): NoteHistory => {
  const { keys, notes } = watchdogNotes(history, slug);
  return withNotes(history, slug, {
    keys: recordKey(keys, { key: normalizeNote(note.text), severity: note.severity }),
    notes: [...notes, note].slice(-RECAP_NOTE_CAP),
  });
};

// §9.1, §9.4: a raise lifts the key and its newest note; a displacement changes only the note's state.
export const updateNote = (
  history: NoteHistory,
  slug: string,
  change: { readonly key: string; readonly severity?: Severity; readonly delivery: DeliveryState }
): NoteHistory => {
  const { keys, notes } = watchdogNotes(history, slug);
  const index = notes.findLastIndex((note) => normalizeNote(note.text) === change.key);
  const found = notes[index];
  return withNotes(history, slug, {
    keys: change.severity === undefined ? keys : recordKey(keys, { key: change.key, severity: change.severity }),
    notes:
      found === undefined
        ? notes
        : notes.with(index, {
            text: found.text,
            severity: change.severity ?? found.severity,
            delivery: change.delivery,
          }),
  });
};

// A stored JSON object, field by field, before each field is checked.
type Stored = {
  readonly watchdogs?: unknown;
  readonly lastUsed?: unknown;
  readonly keys?: unknown;
  readonly notes?: unknown;
  readonly key?: unknown;
  readonly text?: unknown;
  readonly severity?: unknown;
  readonly delivery?: unknown;
};

const isStored = (value: unknown): value is Stored =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isGuardKey = (value: unknown): value is GuardKey =>
  isStored(value) && typeof value.key === 'string' && isSeverity(value.severity);

const isRecapNote = (value: unknown): value is RecapNote =>
  isStored(value) && typeof value.text === 'string' && isSeverity(value.severity) && isDeliveryState(value.delivery);

const listOf = <T>(value: unknown, isEntry: (entry: unknown) => entry is T, cap: number): T[] =>
  Array.isArray(value) ? value.filter(isEntry).slice(-cap) : [];

const readNotes = ([slug, value]: [string, unknown]): [string, WatchdogNotes][] =>
  isStored(value)
    ? [
        [
          slug,
          {
            keys: listOf(value.keys, isGuardKey, NOTE_KEY_CAP),
            notes: listOf(value.notes, isRecapNote, RECAP_NOTE_CAP),
          },
        ],
      ]
    : [];

// §9.6: the stored value as the mod reads it at load; a missing or broken value is an empty history, and a
// broken entry is left out.
export const readHistory = (value: unknown): NoteHistory =>
  isStored(value)
    ? {
        watchdogs: Object.fromEntries(
          Object.entries(isStored(value.watchdogs) ? value.watchdogs : {}).flatMap(readNotes)
        ),
        lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : 0,
      }
    : EMPTY_HISTORY;

// §9.6: the live copy of one session's history in module memory, and whether its session already showed a
// refused write (§14.2: one row for each session).
const live: { sessionId: string | undefined; history: NoteHistory; isErrorShown: boolean } = {
  sessionId: undefined,
  history: EMPTY_HISTORY,
  isErrorShown: false,
};

// The live copy, or undefined before the first load for this session id.
export const liveHistory = (sessionId: string): NoteHistory | undefined =>
  live.sessionId === sessionId ? live.history : undefined;

export const setLiveHistory = (sessionId: string, history: NoteHistory): void => {
  live.isErrorShown = live.isErrorShown && live.sessionId === sessionId;
  live.sessionId = sessionId;
  live.history = history;
};

// True once for each session: the first refused write of that session shows a row.
export const claimErrorRow = (): boolean => {
  const isFirst = !live.isErrorShown;
  live.isErrorShown = true;
  return isFirst;
};
