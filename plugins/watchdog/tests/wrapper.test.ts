import { describe, expect, test } from 'claude-code/testing';
import { wrapNotes, wrappedNote } from '../hooks/delivery/wrapper';

const GUIDANCE = 'The following is an aggregated review from other models.\n';

describe('the <watchdog-notes> wrapper', () => {
  test('the guidance is the second line and each note is one element', () => {
    const text = wrapNotes(GUIDANCE, [
      { severity: 'concern', turnsAgo: 0, text: 'parseDate drops the timezone.' },
      { watchdog: 'security', severity: 'blocker', turnsAgo: 2, text: 'The token is logged.' },
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
      { watchdog: 'a"<b>&c', severity: 'nit', turnsAgo: 1, text: 'Use `a < b && c > d` in "x".' },
    ]);

    expect(text).toContain(
      '<note watchdog="a&quot;&lt;b&gt;&amp;c" severity="nit" turns_ago="1">' +
        'Use `a &lt; b &amp;&amp; c &gt; d` in &quot;x&quot;.</note>'
    );
  });

  test('a held note loses its name for the default watchdog and takes its age from the counter', () => {
    const base = { agentId: 'afake0001', severity: 'concern', text: 'x', turn: 3 } as const;

    expect(wrappedNote({ ...base, watchdog: 'default' }, 'default', 3)).toEqual({
      severity: 'concern',
      turnsAgo: 0,
      text: 'x',
    });
    expect(wrappedNote({ ...base, watchdog: 'security' }, 'Security', 5)).toEqual({
      watchdog: 'Security',
      severity: 'concern',
      turnsAgo: 2,
      text: 'x',
    });
  });
});
