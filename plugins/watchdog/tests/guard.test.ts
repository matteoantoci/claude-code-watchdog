import { describe, expect, test } from 'claude-code/testing';
import { judgeNote, normalizeNote } from '../hooks/note/guard';
import type { GuardView } from '../hooks/note/guard';

// A fresh watchdog: no key seen, nothing held, an empty review with the default budget of 4.
const FRESH: GuardView = { seen: undefined, slots: [], budget: 4, pendingSeverity: () => undefined };

const judge = (text: string, severity: 'nit' | 'concern' | 'blocker', view: GuardView = FRESH) =>
  judgeNote({ key: normalizeNote(text), severity }, view);

const nits = (keys: readonly string[]) => keys.map((key) => ({ key, severity: 'nit' as const }));

describe('emission guard: normalization', () => {
  test('lowercases, applies NFKC, folds each run of non-letters and non-digits to one space, trims', () => {
    expect(normalizeNote('  No issue; continue.  ')).toBe('no issue continue');
    expect(normalizeNote('Ｆｉｘ  the—NULL check!!')).toBe('fix the null check');
    expect(normalizeNote('Größe: 2×3')).toBe('größe 2 3');
  });
});

describe('emission guard: order empty, noise, duplicate, budget', () => {
  test('an empty or punctuation-only note is `empty`', () => {
    expect(judge('', 'concern')).toEqual({ kind: 'dropped', reason: 'empty' });
    expect(judge(' ... !? ', 'blocker')).toEqual({ kind: 'dropped', reason: 'empty' });
  });

  test('each of the 39 noise phrases is `noise` in any case and punctuation, even as a blocker', () => {
    const phrases = [
      'Stop.',
      'stop here',
      'Stop now!',
      'HALT',
      'abort',
      'Done.',
      'task done',
      'Task complete.',
      'complete',
      'finished',
      'OK',
      'okay',
      'ok, done',
      'No issue.',
      'no issues',
      'No issue; continue.',
      'no concerns',
      'no concern',
      'Nothing to add.',
      'nothing to flag',
      'nothing to report',
      'no notes',
      'No further input.',
      'no further input needed',
      'no further input required',
      'no further watcher input',
      'no further watcher input needed',
      'no further advice',
      'no further advice needed',
      'LGTM',
      'Looks good!',
      'all good',
      'Agent is on track.',
      'agent on track',
      'on track',
      'Continue.',
      'carry on',
      'No further watchdog input.',
      'no further watchdog input needed',
    ];
    expect(phrases.length).toBe(39);
    for (const phrase of phrases) {
      expect(judge(phrase, 'blocker')).toEqual({ kind: 'dropped', reason: 'noise' });
    }
  });

  test('noise is an exact match of the whole note, so a stop with a reason passes', () => {
    expect(judge("Stop: 'await' missing on writeStream.end() will lose buffered writes.", 'blocker')).toEqual({
      kind: 'admitted',
      slots: [],
    });
  });

  test('a repeat at the same or a lower severity is `duplicate`; a higher one passes', () => {
    const seen: GuardView = { ...FRESH, seen: 'concern' };
    expect(judge('Missing null check!', 'concern', seen)).toEqual({ kind: 'dropped', reason: 'duplicate' });
    expect(judge('missing null check', 'nit', seen)).toEqual({ kind: 'dropped', reason: 'duplicate' });
    expect(judge('missing null check', 'blocker', seen)).toEqual({ kind: 'admitted', slots: [] });
  });

  test('noise comes before duplicate, and duplicate before the budget', () => {
    const full: GuardView = {
      seen: 'nit',
      slots: [
        { key: 'a', severity: 'nit' },
        { key: 'b', severity: 'nit' },
      ],
      budget: 2,
      pendingSeverity: () => undefined,
    };
    expect(judge('lgtm', 'nit', { ...full, seen: 'blocker' })).toEqual({ kind: 'dropped', reason: 'noise' });
    expect(judge('c', 'nit', full)).toEqual({ kind: 'dropped', reason: 'duplicate' });
    expect(judge('c', 'nit', { ...full, seen: undefined })).toEqual({ kind: 'dropped', reason: 'rate-limit' });
  });
});

describe('emission guard: queued entries and the budget', () => {
  test('a higher repeat of a queued key raises that entry in place and takes no new slot', () => {
    const view: GuardView = {
      seen: 'nit',
      slots: nits(['x']),
      budget: 1,
      pendingSeverity: (key) => (key === 'x' ? 'nit' : undefined),
    };
    expect(judge('X', 'concern', view)).toEqual({ kind: 'raised', slots: [{ key: 'x', severity: 'concern' }] });
    expect(judge('x', 'nit', view)).toEqual({ kind: 'dropped', reason: 'duplicate' });
  });

  test('a raise to blocker frees the slot of the key', () => {
    const view: GuardView = { seen: 'concern', slots: nits(['a', 'x']), budget: 2, pendingSeverity: () => 'concern' };
    expect(judge('x', 'blocker', view)).toEqual({ kind: 'raised', slots: nits(['a']) });
  });

  test('a queued key that the history lost still drops an equal repeat', () => {
    const view: GuardView = { ...FRESH, pendingSeverity: () => 'concern' };
    expect(judge('x', 'concern', view)).toEqual({ kind: 'dropped', reason: 'duplicate' });
  });

  test('a note takes a slot while the budget has room', () => {
    const view: GuardView = { ...FRESH, slots: nits(['a']), budget: 2 };
    expect(judge('b', 'concern', view)).toEqual({
      kind: 'admitted',
      slots: [...nits(['a']), { key: 'b', severity: 'concern' }],
    });
  });

  test('a blocker takes no slot, even when the budget is full', () => {
    const view: GuardView = { ...FRESH, slots: nits(['a']), budget: 1 };
    expect(judge('c', 'blocker', view)).toEqual({ kind: 'admitted', slots: nits(['a']) });
  });

  test('a full budget: a higher note displaces the lowest undelivered note, the first of equals', () => {
    const view: GuardView = {
      ...FRESH,
      slots: [{ key: 'a', severity: 'concern' }, ...nits(['x', 'b', 'c'])],
      budget: 4,
      pendingSeverity: (key) => (['a', 'b', 'c'].includes(key) ? 'nit' : undefined),
    };
    expect(judge('d', 'concern', view)).toEqual({
      kind: 'admitted',
      slots: [{ key: 'a', severity: 'concern' }, ...nits(['x']), { key: 'd', severity: 'concern' }, ...nits(['c'])],
      displaced: 'b',
    });
  });

  test('a full budget: a delivered note is never displaced, so the new note is `rate-limit`', () => {
    const delivered: GuardView = { ...FRESH, slots: nits(['a', 'b']), budget: 2 };
    expect(judge('c', 'concern', delivered)).toEqual({ kind: 'dropped', reason: 'rate-limit' });
  });

  test('a full budget: a note no higher than the lowest undelivered one is `rate-limit`', () => {
    const view: GuardView = {
      ...FRESH,
      slots: nits(['a', 'b']),
      budget: 2,
      pendingSeverity: (key) => (key === 'c' ? undefined : 'nit'),
    };
    expect(judge('c', 'nit', view)).toEqual({ kind: 'dropped', reason: 'rate-limit' });
  });

  test('a delivered key of this review that comes back higher keeps its one slot', () => {
    const view: GuardView = { seen: 'nit', slots: nits(['a', 'x']), budget: 2, pendingSeverity: () => undefined };
    expect(judge('x', 'concern', view)).toEqual({
      kind: 'admitted',
      slots: [...nits(['a']), { key: 'x', severity: 'concern' }],
    });
  });
});
