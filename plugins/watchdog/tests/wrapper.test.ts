import { describe, expect, test } from 'claude-code/testing';
import { wrapNotes, wrappedNote } from '../hooks/delivery/wrapper';

const GUIDANCE = 'The following is an aggregated review from other models.\n';

describe('the <watchdog-notes> wrapper', () => {
  test('the guidance is the second line and each note is one element', () => {
    const text = wrapNotes(GUIDANCE, [
      { severity: 'concern', turnsAgo: 0, edits: 0, text: 'parseDate drops the timezone.' },
      { watchdog: 'security', severity: 'blocker', turnsAgo: 2, edits: 0, text: 'The token is logged.' },
    ]);

    expect(text).toBe(
      [
        '<watchdog-notes>',
        'The following is an aggregated review from other models.',
        '<note severity="concern">parseDate drops the timezone.</note>',
        '<note watchdog="security" severity="blocker" turns_ago="2">The token is logged.</note>',
        '</watchdog-notes>',
      ].join('\n')
    );
  });

  test('the note text and the watchdog name are XML-escaped', () => {
    const text = wrapNotes(GUIDANCE, [
      { watchdog: 'a"<b>&c', severity: 'nit', turnsAgo: 1, edits: 0, text: 'Use `a < b && c > d` in "x".' },
    ]);

    expect(text).toContain(
      '<note watchdog="a&quot;&lt;b&gt;&amp;c" severity="nit" turns_ago="1">' +
        'Use `a &lt; b &amp;&amp; c &gt; d` in &quot;x&quot;.</note>'
    );
  });

  test('§10.8: a note with edits since its batch on a file it names carries the outdated attribute', () => {
    const text = wrapNotes(GUIDANCE, [
      { severity: 'blocker', turnsAgo: 1, edits: 1, text: 'cart.py line 3 subtracts.' },
      { severity: 'concern', turnsAgo: 0, edits: 2, text: 'cart.py has no test.' },
    ]);

    expect(text).toContain(
      '<note severity="blocker" turns_ago="1" outdated="1 edit since its review">cart.py line 3 subtracts.</note>'
    );
    expect(text).toContain('<note severity="concern" outdated="2 edits since its review">cart.py has no test.</note>');
  });

  test('a held note loses its name for the default watchdog and takes its age from the counter', () => {
    const base = { agentId: 'afake0001', severity: 'concern', text: 'x', batchEnd: null, turn: 3 } as const;

    expect(wrappedNote({ ...base, watchdog: 'default' }, { name: 'default', turn: 3, edits: 0 })).toEqual({
      severity: 'concern',
      turnsAgo: 0,
      edits: 0,
      text: 'x',
    });
    expect(wrappedNote({ ...base, watchdog: 'security' }, { name: 'Security', turn: 5, edits: 1 })).toEqual({
      watchdog: 'Security',
      severity: 'concern',
      turnsAgo: 2,
      edits: 1,
      text: 'x',
    });
  });
});
