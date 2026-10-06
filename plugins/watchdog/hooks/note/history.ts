import { NOTE_KEY_CAP, RECAP_NOTE_CAP } from '../constants';
import { normalizeNote } from './guard';
import { isDeliveryState } from './notes';
import { isSeverity, severityRank } from './tool';
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

// §14.2: the primary agent's key, and with an `agentId` the key of one watched subagent (§11.4).
export const notesKey = (sessionId: string, agentId?: string): string =>
  agentId === undefined ? `notes:${sessionId}` : `notes:${sessionId}:${agentId}`;

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

// §11.4: a late note on a subagent that goes to the primary agent records its key in the primary agent's set.
export const recordGuardKey = (history: NoteHistory, slug: string, entry: GuardKey): NoteHistory => {
  const { keys, notes } = watchdogNotes(history, slug);
  return withNotes(history, slug, { keys: recordKey(keys, entry), notes });
};

// §9.6: a rewind clears the guard keys of each watchdog and keeps its recap notes.
export const clearGuardKeys = (history: NoteHistory): NoteHistory => ({
  ...history,
  watchdogs: Object.fromEntries(
    Object.entries(history.watchdogs).map(([slug, { notes }]) => [slug, { keys: [], notes }])
  ),
});

// §9.2, §11.4: the set already holds the key at the same or a higher severity, so the note repeats.
export const isRepeat = (history: NoteHistory, slug: string, entry: GuardKey): boolean => {
  const seen = watchdogNotes(history, slug).keys.find((known) => known.key === entry.key)?.severity;
  return seen !== undefined && severityRank(seen) >= severityRank(entry.severity);
};

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

// §9.6, §11.4: the live copies of one session's histories in module memory (the primary agent's, and one for
// each watched subagent by its `agentId`). A new session id starts them again.
const PRIMARY = '';

const live: { sessionId: string | undefined; histories: Map<string, NoteHistory> } = {
  sessionId: undefined,
  histories: new Map(),
};

// The live copy, or undefined before the first load for this session id and watched agent.
export const liveHistory = (sessionId: string, agentId?: string): NoteHistory | undefined =>
  live.sessionId === sessionId ? live.histories.get(agentId ?? PRIMARY) : undefined;

export const setLiveHistory = (sessionId: string, history: NoteHistory, agentId?: string): void => {
  if (live.sessionId !== sessionId) {
    live.histories.clear();
  }
  live.sessionId = sessionId;
  live.histories.set(agentId ?? PRIMARY, history);
};
