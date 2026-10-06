import { describe, expect, test } from 'claude-code/testing';
import { DEFAULT_WATCHDOG } from '../hooks/agents/roster';
import { reviewRecord } from '../hooks/log/log';
import { EMPTY_TALLY, addReview } from '../hooks/status/ledger';
import { statusTable } from '../hooks/status/table';
import type { Watchdog } from '../hooks/agents/roster';
import type { Tally } from '../hooks/status/ledger';

const SECURITY: Watchdog = {
  ...DEFAULT_WATCHDOG,
  name: 'security',
  slug: 'security',
  model: 'sonnet',
  effort: 'high',
  tools: ['Read', 'Grep', 'Glob', 'WebFetch'],
  source: '~/.claude/WATCHDOG.json',
};

const STYLE: Watchdog = { ...DEFAULT_WATCHDOG, name: 'style', slug: 'style', source: './WATCHDOG.json' };

// One finished review of `watchdog` on `model` with these token counts and notes; a failed one has no usage.
const review = (
  tally: Tally,
  watchdog: Watchdog,
  usage: { model: string; input: number; output: number; notes?: readonly string[] } | undefined
): Tally =>
  addReview(
    tally,
    reviewRecord({
      watchdog,
      agentId: 'afake0001',
      time: 0,
      end: {
        turnId: 'r1',
        reason: usage === undefined ? 'error' : 'answer',
        answer: '',
        durationMs: 5,
        isAborted: false,
        ...(usage === undefined
          ? {}
          : {
              usage: {
                input_tokens: usage.input,
                output_tokens: usage.output,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                model: usage.model,
              },
            }),
      },
      trace: {
        steps: 1,
        notes: (usage?.notes ?? []).map((severity) => ({ severity, text: 'n', delivery: 'held' })),
        error: null,
      },
    })
  );

const SECTIONS = {
  head: ['watchdog on', 'nudge 1/1', 'cooldown 3'],
  errors: [],
  lines: ['on source: /watchdog on', 'warning: ./WATCHDOG.json: unknown key "x"; key dropped'],
};

describe('/watchdog status table (§13.3)', () => {
  test('one row for each watchdog with model/effort, state, reviews, notes, tokens, cost and its file', () => {
    // Sonnet 5.5: 5000 × $2 + 1000 × $10 per million = $0.02, twice; 12k tokens.
    const ran = { model: 'claude-sonnet-5-5', input: 5000, output: 1000 };
    const security = review(review(EMPTY_TALLY, SECURITY, { ...ran, notes: ['blocker', 'concern'] }), SECURITY, {
      ...ran,
      notes: ['concern'],
    });
    const table = statusTable({
      text: 'reply',
      sections: SECTIONS,
      watchdogs: [{ watchdog: SECURITY, slot: { state: 'idle' }, parts: [], tally: security }],
      session: security,
      configFile: '~/.claude/WATCHDOG.json',
    });
    expect(table.head).toBe('watchdog on · nudge 1/1 · cooldown 3 · 12.0k tok · $0.04');
    expect(table.rows).toEqual([
      {
        name: 'security*',
        model: 'claude-sonnet-5-5/high',
        state: { text: 'idle', isRed: false },
        reviews: '2',
        notes: '1B 2C 0N',
        tokens: '12.0k',
        cost: '$0.04',
        source: '~/.claude/WATCHDOG.json',
        detail: [],
      },
    ]);
    expect(table.session).toMatchObject({ name: 'session', reviews: '2', notes: '1B 2C 0N', cost: '$0.04' });
    expect(table.lastError).toEqual([{ text: 'last error: none', isRed: false }]);
    expect(table.lines).toEqual([
      '* has a tool other than Read, Grep and Glob',
      'on source: /watchdog on',
      'warning: ./WATCHDOG.json: unknown key "x"; key dropped',
    ]);
  });

  test('before a review ran, the roster model shows; the default watchdog row hints at the user file', () => {
    const table = statusTable({
      text: 'reply',
      sections: SECTIONS,
      watchdogs: [{ watchdog: DEFAULT_WATCHDOG, slot: { state: 'idle' }, parts: [], tally: EMPTY_TALLY }],
      session: EMPTY_TALLY,
      configFile: '~/.claude/WATCHDOG.json',
    });
    expect(table.rows[0]).toMatchObject({
      name: 'default',
      model: 'opus/medium',
      reviews: '0',
      notes: '0B 0C 0N',
      tokens: '0',
      cost: '$0.00',
      source: 'write ~/.claude/WATCHDOG.json to add watchdogs',
    });
    expect(table.lines).not.toContain('* has a tool other than Read, Grep and Glob');
  });

  test('a model that is not in the price table shows its tokens and `$?`; the session sums every watchdog', () => {
    const opus45 = { model: 'claude-opus-4-5', input: 900, output: 50 };
    // Sonnet 5.5: 1.2M × $2 + 100k × $10 per million = $3.40.
    const sonnet55 = { model: 'claude-sonnet-5-5', input: 1_200_000, output: 100_000 };
    const style = review(EMPTY_TALLY, STYLE, opus45);
    const security = review(EMPTY_TALLY, SECURITY, sonnet55);
    const session = review(review(EMPTY_TALLY, STYLE, opus45), SECURITY, sonnet55);
    const table = statusTable({
      text: 'reply',
      sections: SECTIONS,
      watchdogs: [
        { watchdog: STYLE, slot: { state: 'idle' }, parts: [], tally: style },
        { watchdog: SECURITY, slot: { state: 'idle' }, parts: [], tally: security },
      ],
      session,
      configFile: undefined,
    });
    expect(table.rows.map((row) => [row.tokens, row.cost])).toEqual([
      ['950', '$?'],
      ['1.3M', '$3.40'],
    ]);
    expect(table.session).toMatchObject({ reviews: '2', tokens: '1.3M', cost: '$3.40+?' });
  });

  test('a problem state is red with its reason and parts under the row; `fail N/3` is red; the last error shows', () => {
    const table = statusTable({
      text: 'reply',
      sections: { ...SECTIONS, errors: ['last error: style: API Error: 529 Overloaded.'] },
      watchdogs: [
        {
          watchdog: SECURITY,
          slot: { state: 'no_model', reason: 'model sonnet is not in availableModels' },
          parts: [],
          tally: EMPTY_TALLY,
        },
        { watchdog: STYLE, slot: { state: 'idle' }, parts: ['fail 1/3', 'refused 1'], tally: EMPTY_TALLY },
      ],
      session: EMPTY_TALLY,
      configFile: undefined,
    });
    expect(table.rows.map((row) => [row.state, row.detail])).toEqual([
      [{ text: 'no_model', isRed: true }, [{ text: 'model sonnet is not in availableModels', isRed: true }]],
      [
        { text: 'idle', isRed: false },
        [
          { text: 'fail 1/3', isRed: true },
          { text: 'refused 1', isRed: false },
        ],
      ],
    ]);
    expect(table.lastError).toEqual([{ text: 'last error: style: API Error: 529 Overloaded.', isRed: true }]);
  });

  test('off, the table is the first line and the lines; the session totals show once a review ran', () => {
    const off = { head: ['watchdog off'], errors: [], lines: [] };
    const empty = statusTable({ text: 'r', sections: off, watchdogs: [], session: EMPTY_TALLY, configFile: undefined });
    expect(empty).toEqual({ text: 'r', head: 'watchdog off', rows: [], session: null, lastError: [], lines: [] });
    const ran = review(EMPTY_TALLY, STYLE, { model: 'claude-sonnet-5-5', input: 5000, output: 0 });
    const after = statusTable({ text: 'r', sections: off, watchdogs: [], session: ran, configFile: undefined });
    expect(after.head).toBe('watchdog off · 5.0k tok · $0.01');
    expect(after.session).toMatchObject({ reviews: '1', tokens: '5.0k' });
  });
});

describe('ledger', () => {
  test('a failed review counts as a review with no tokens and no cost', () => {
    const failed = review(EMPTY_TALLY, STYLE, undefined);
    expect(failed).toEqual({ ...EMPTY_TALLY, reviews: 1 });
  });

  test('the model that ran is the last review usage model', () => {
    const tally = review(
      review(EMPTY_TALLY, SECURITY, { model: 'claude-sonnet-5-5', input: 1, output: 1 }),
      SECURITY,
      undefined
    );
    expect(tally.model).toBe('claude-sonnet-5-5');
  });

  test('only admitted notes count: a displaced, discarded or dropped note of the trace adds none', () => {
    const notes = [
      { severity: 'concern', text: 'a', delivery: 'held' },
      { severity: 'concern', text: 'a', delivery: 'displaced' },
      { severity: 'blocker', text: 'b', delivery: 'dropped:unsafe' },
      { severity: 'nit', text: 'c', delivery: 'discarded' },
      { severity: 'blocker', text: 'd', delivery: 'nudged' },
    ];
    const end = { turnId: 'r1', reason: 'error', answer: '', durationMs: 5, isAborted: false } as const;
    const record = reviewRecord({
      watchdog: STYLE,
      agentId: 'afake0001',
      time: 0,
      end,
      trace: { steps: 1, notes, error: null },
    });
    expect(addReview(EMPTY_TALLY, record).notes).toEqual({ blocker: 1, concern: 1, nit: 0 });
  });
});
