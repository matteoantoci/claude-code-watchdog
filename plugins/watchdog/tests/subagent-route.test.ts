import { describe, expect, test } from 'claude-code/testing';
import { DEFAULT_WATCHDOG } from '../hooks/agents/roster';
import { wrapNotes, wrappedNote } from '../hooks/delivery/wrapper';
import { recordText } from '../hooks/dump/dump';
import { reviewRecord } from '../hooks/log/log';
import { logRow } from '../hooks/note/notes';
import {
  endSubagent,
  isSubagentSteer,
  optInSlugs,
  subagentRoute,
  subagentStatusLines,
  watchSubagent,
} from '../hooks/subagents/watch';
import type { LogRecord } from '../hooks/log/log';
import type { HeldNote, Note } from '../hooks/note/notes';

// The watchdogs that review in this session, in roster order.
const REVIEWERS = ['default', 'security', 'style'];

const spawn = (subagentType: string) => ({ subagentType, fork: false, isInWatchdog: false });

describe('the subagents opt-in (§11.1)', () => {
  test('true opts the exact type in for every watchdog; a list for the listed watchdogs that review', () => {
    const subagents = { Explore: true, 'my-plugin:coder': ['style', 'gone', 'default'] } as const;
    expect(optInSlugs(subagents, REVIEWERS, spawn('Explore'))).toEqual(['default', 'security', 'style']);
    expect(optInSlugs(subagents, REVIEWERS, spawn('my-plugin:coder'))).toEqual(['default', 'style']);
  });

  test('a type the map does not name, a case variant and an inherited object key are not opted in', () => {
    const subagents = { Explore: true } as const;
    expect(optInSlugs(subagents, REVIEWERS, spawn('Plan'))).toEqual([]);
    expect(optInSlugs(subagents, REVIEWERS, spawn('explore'))).toEqual([]);
    expect(optInSlugs(subagents, REVIEWERS, spawn('toString'))).toEqual([]);
  });

  test('a teammate, a fork, a spawn inside a watchdog agent and a watchdog:* key never count', () => {
    const subagents = { Explore: true, fork: true, 'watchdog:default': true } as const;
    expect(optInSlugs(subagents, REVIEWERS, { ...spawn('Explore'), isTeammate: true })).toEqual([]);
    expect(optInSlugs(subagents, REVIEWERS, { ...spawn('fork'), fork: true })).toEqual([]);
    expect(optInSlugs(subagents, REVIEWERS, { ...spawn('Explore'), isInWatchdog: true })).toEqual([]);
    expect(optInSlugs(subagents, REVIEWERS, spawn('watchdog:default'))).toEqual([]);
  });
});

const EXPLORE = { agentId: 'asub0001', type: 'Explore' };

const note = (subagent?: typeof EXPLORE): Note => ({
  watchdog: 'security',
  agentId: 'afake0001',
  severity: 'concern',
  text: 'The parser drops the <tz> offset.',
  turn: 2,
  ...(subagent === undefined ? {} : { subagent }),
});

describe('the route of a note on a subagent (§11.3)', () => {
  test('while the subagent runs, every severity is a steer into it; once it ended, the primary routes take it', () => {
    watchSubagent({ ...EXPLORE, task: 'Find the parser.', watchdogs: ['security'] });
    for (const severity of ['nit', 'concern', 'blocker'] as const) {
      expect(subagentRoute({ ...note(EXPLORE), severity })).toBe('steered');
    }
    const held: HeldNote = { ...note(EXPLORE), delivery: 'steered' };
    expect(isSubagentSteer(held)).toBe(true);
    expect(isSubagentSteer({ ...held, delivery: 'nudged' })).toBe(false);

    endSubagent(EXPLORE.agentId);
    expect(subagentRoute(note(EXPLORE))).toBeUndefined();
    expect(isSubagentSteer(held)).toBe(false);
  });

  test('a note on the primary agent and a note on a subagent the mod does not watch are not routed here', () => {
    expect(subagentRoute(note())).toBeUndefined();
    expect(subagentRoute(note({ agentId: 'asub9999', type: 'Plan' }))).toBeUndefined();
  });
});

describe('the subagent label (§10.7, §11.3)', () => {
  test('a late note on a subagent has the subagent attribute, XML-escaped; a primary note has none', () => {
    const late = wrappedNote(note({ agentId: 'asub0001', type: 'my-plugin:"coder"' }), 'Security', 3);
    expect(wrapNotes('Weigh these notes.', [late, wrappedNote(note(), 'Security', 2)])).toBe(
      [
        '<watchdog-notes>',
        'Weigh these notes.',
        '<note watchdog="Security" severity="concern" subagent="my-plugin:&quot;coder&quot;" turns_ago="1">The parser drops the &lt;tz&gt; offset.</note>',
        '<note watchdog="Security" severity="concern">The parser drops the &lt;tz&gt; offset.</note>',
        '</watchdog-notes>',
      ].join('\n')
    );
  });

  test('the log row shows the subagent type beside the severity', () => {
    expect(logRow({ ...note(EXPLORE), delivery: 'steered' }, 'Security')).toBe(
      '[concern · Explore] Security: The parser drops the <tz> offset. (steered)'
    );
    expect(logRow({ ...note(), delivery: 'nudged' }, 'Security')).toBe(
      '[concern] Security: The parser drops the <tz> offset. (nudged)'
    );
  });
});

// One finished review; of a subagent of this type when a type is given.
const review = (type?: string): LogRecord =>
  reviewRecord({
    watchdog: DEFAULT_WATCHDOG,
    agentId: 'afake0001',
    time: 0,
    end: { turnId: 'r1', reason: 'answer', answer: '', durationMs: 5, isAborted: false },
    trace: { steps: 1, notes: [], error: null },
    subagent: type === undefined ? undefined : { agentId: 'asub0001', type },
  });

describe('the subagent status lines (§11.1, §11.4)', () => {
  const log = [review('Explore'), review(), review('Explore'), review('Plan')];

  test('one line for each opted-in type with its review count', () => {
    expect(subagentStatusLines(['Explore', 'Plan', 'my-plugin:coder'], new Set(), log)).toEqual([
      'subagents: Explore 2 reviews',
      'subagents: Plan 1 review',
      'subagents: my-plugin:coder 0 reviews',
    ]);
  });

  test('a watchdog:* key and a key that no agent.offer gave are warnings; no offer yet means no unknown key', () => {
    const keys = ['Explore', 'Explroe', 'watchdog:default'];
    expect(subagentStatusLines(keys, new Set(['Explore', 'Plan']), [])).toEqual([
      'subagents: Explore 0 reviews',
      'subagents: Explroe 0 reviews',
      'warning: subagents "watchdog:default": a watchdog type, ignored',
      'warning: subagents "Explroe": no agent.offer gave this type',
    ]);
    expect(subagentStatusLines(keys, new Set(), [])).not.toContain(
      'warning: subagents "Explroe": no agent.offer gave this type'
    );
  });

  test('a review record of a subagent keeps its type and agentId; the dump heading labels it', () => {
    expect(review('Explore')).toMatchObject({ subagent: { agentId: 'asub0001', type: 'Explore' } });
    expect(review()).not.toHaveProperty('subagent');
    expect(recordText(review('Explore')).split('\n')[0]).toBe(
      '### 1970-01-01T00:00:00Z · default · review afake0001 · subagent Explore asub0001'
    );
    expect(recordText(review()).split('\n')[0]).toBe('### 1970-01-01T00:00:00Z · default · review afake0001');
  });
});
