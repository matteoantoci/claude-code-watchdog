import { describe, expect, test } from 'claude-code/testing';
import { EMPTY_HISTORY, notesKey, readHistory, recordNote, updateNote, watchdogNotes } from '../hooks/note/history';

const note = (text: string) => ({ text, severity: 'nit' as const, delivery: 'held' as const });

describe('note history `notes:<sessionId>`', () => {
  test('the store key holds the session id', () => {
    expect(notesKey('3f2a')).toBe('notes:3f2a');
  });

  test('an admitted note records its guard key and joins the recap notes of its watchdog only', () => {
    const history = recordNote(EMPTY_HISTORY, 'default', {
      text: 'Missing null check!',
      severity: 'concern',
      delivery: 'steered',
    });
    expect(watchdogNotes(history, 'default')).toEqual({
      keys: [{ key: 'missing null check', severity: 'concern' }],
      notes: [{ text: 'Missing null check!', severity: 'concern', delivery: 'steered' }],
    });
    expect(watchdogNotes(history, 'security')).toEqual({ keys: [], notes: [] });
  });

  test('the guard keys are FIFO with a cap of 200, and the recap keeps the newest 20 notes', () => {
    const history = Array.from({ length: 205 }, (_, index) => `note ${index}`).reduce(
      (kept, text) => recordNote(kept, 'default', note(text)),
      EMPTY_HISTORY
    );
    const { keys, notes } = watchdogNotes(history, 'default');
    expect(keys.length).toBe(200);
    expect(keys[0]).toEqual({ key: 'note 5', severity: 'nit' });
    expect(keys.at(-1)).toEqual({ key: 'note 204', severity: 'nit' });
    expect(notes.length).toBe(20);
    expect(notes[0]?.text).toBe('note 185');
    expect(notes.at(-1)?.text).toBe('note 204');
  });

  test('a raise lifts the key in place and changes the newest recap note of that key', () => {
    const first = recordNote(recordNote(EMPTY_HISTORY, 'default', note('A')), 'default', note('b'));
    const raised = updateNote(first, 'default', { key: 'a', severity: 'concern', delivery: 'steered' });
    expect(watchdogNotes(raised, 'default')).toEqual({
      keys: [
        { key: 'a', severity: 'concern' },
        { key: 'b', severity: 'nit' },
      ],
      notes: [{ text: 'A', severity: 'concern', delivery: 'steered' }, note('b')],
    });
  });

  test('a displaced note keeps its key and gets the `displaced` state', () => {
    const history = updateNote(recordNote(EMPTY_HISTORY, 'default', note('a')), 'default', {
      key: 'a',
      delivery: 'displaced',
    });
    expect(watchdogNotes(history, 'default')).toEqual({
      keys: [{ key: 'a', severity: 'nit' }],
      notes: [{ text: 'a', severity: 'nit', delivery: 'displaced' }],
    });
  });

  test('a stored value reads back; a missing or broken value reads as empty, a broken entry is left out', () => {
    const stored = recordNote(EMPTY_HISTORY, 'default', note('a'));
    expect(readHistory(JSON.parse(JSON.stringify({ ...stored, lastUsed: 17 })))).toEqual({ ...stored, lastUsed: 17 });
    expect(readHistory(undefined)).toEqual(EMPTY_HISTORY);
    expect(readHistory('notes')).toEqual(EMPTY_HISTORY);
    expect(
      readHistory({
        watchdogs: {
          default: {
            keys: [{ key: 'a', severity: 'nit' }, { key: 1 }],
            notes: [note('a'), { text: 'b', severity: 'urgent' }],
          },
          broken: 3,
        },
        lastUsed: 'yesterday',
      })
    ).toEqual({ watchdogs: { default: { keys: [{ key: 'a', severity: 'nit' }], notes: [note('a')] } }, lastUsed: 0 });
  });
});
