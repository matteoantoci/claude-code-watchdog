import { describe, expect, test } from 'claude-code/testing';
import { DEFAULT_WATCHDOG } from '../hooks/agents/roster';
import { dumpPath, dumpText, recordText } from '../hooks/dump/dump';
import { appendLog, errorRecord, reviewRecord, timeoutRecord } from '../hooks/log/log';
import type { LogRecord } from '../hooks/log/log';

// 2026-10-06T09:05:03Z
const TIME = Date.UTC(2026, 9, 6, 9, 5, 3);

const END = {
  turnId: 'r1',
  reason: 'answer',
  answer: 'Looks fine.',
  durationMs: 5,
  isAborted: false,
  agentId: 'afake0001',
  usage: {
    input_tokens: 1200,
    output_tokens: 80,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
    model: 'claude-opus-4-5',
  },
} as const;

const TRACE = {
  steps: 3,
  notes: [{ severity: 'concern', text: 'Check the null branch.', delivery: 'held' }],
  error: null,
};

const record = (): LogRecord =>
  reviewRecord({ watchdog: DEFAULT_WATCHDOG, agentId: 'afake0001', time: TIME, end: END, trace: TRACE });

describe('review log record', () => {
  test('a review record keeps the §13.4 fields, the turn.complete reason, the step count and the answer length', () => {
    expect(record()).toEqual({
      kind: 'review',
      watchdog: 'default',
      agentId: 'afake0001',
      time: TIME,
      model: 'claude-opus-4-5',
      effort: 'medium',
      reason: 'answer',
      steps: 3,
      answerLength: 11,
      answer: 'Looks fine.',
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
        model: 'claude-opus-4-5',
      },
      cost: null,
      notes: [{ severity: 'concern', text: 'Check the null branch.', delivery: 'held' }],
      error: null,
      refusal: null,
    });
  });

  test('a review with no usage keeps the roster model, no usage and the error of its outcome', () => {
    const failed = reviewRecord({
      watchdog: DEFAULT_WATCHDOG,
      agentId: 'afake0001',
      time: TIME,
      end: { turnId: 'r1', reason: 'error', answer: '', durationMs: 5, isAborted: false },
      trace: { steps: 1, notes: [], error: 'API Error: 529 Overloaded.' },
    });
    expect(failed).toMatchObject({
      model: 'opus',
      usage: null,
      reason: 'error',
      steps: 1,
      answerLength: 0,
      error: 'API Error: 529 Overloaded.',
    });
  });

  test('a refusal keeps its refusal.category (§12.3 item 10)', () => {
    const refused = reviewRecord({
      watchdog: DEFAULT_WATCHDOG,
      agentId: 'afake0001',
      time: TIME,
      end: { ...END, reason: 'refusal', refusal: { category: 'cyber', explanation: null } },
      trace: TRACE,
    });
    expect(refused).toMatchObject({ reason: 'refusal', refusal: 'cyber', error: null });
  });

  test('a review on a model of the price table keeps its cost (§15); the dump shows it to the 1/100 cent', () => {
    // Sonnet 5.5: 1200 × $2 + 80 × $10 + 300 × $0.20 + 40 × $2.50 per million = $0.00336.
    const priced = reviewRecord({
      watchdog: DEFAULT_WATCHDOG,
      agentId: 'afake0001',
      time: TIME,
      end: { ...END, usage: { ...END.usage, model: 'claude-sonnet-5-5' } },
      trace: TRACE,
    });
    expect(priced.cost?.toFixed(6)).toBe('0.003360');
    expect(recordText(priced)).toContain('\n- cost: $0.0034\n');
  });

  test('the log keeps the newest 100 records', () => {
    const records = Array.from({ length: 101 }, (_unused, index) =>
      errorRecord({ watchdog: 'default', time: index, error: `e${index}` })
    );
    const log = records.reduce<readonly LogRecord[]>(appendLog, []);
    expect(log.length).toBe(100);
    expect(log[0]).toEqual({ kind: 'error', watchdog: 'default', time: 1, error: 'e1' });
    expect(log.at(-1)).toEqual({ kind: 'error', watchdog: 'default', time: 100, error: 'e100' });
  });
});

describe('dump format', () => {
  test('a review record renders as one markdown block', () => {
    expect(recordText(record())).toBe(
      [
        '### 2026-10-06T09:05:03Z · default · review afake0001',
        '- model: claude-opus-4-5, effort medium',
        '- end: answer, 3 steps, answer 11 chars',
        '- usage: 1200 input, 80 output, 300 cache read, 40 cache write',
        '- cost: $?',
        '- error: none',
        '- notes: 1',
        '  - [concern] Check the null branch. (held)',
        '- answer:',
        '',
        '> Looks fine.',
      ].join('\n')
    );
  });

  test('an error record renders its text', () => {
    expect(recordText(errorRecord({ watchdog: 'default', time: TIME, error: 'append rejected' }))).toBe(
      ['### 2026-10-06T09:05:03Z · default · error', '- error: append rejected'].join('\n')
    );
  });

  test('a timeout record names the stopped agent (§7.8 action 6)', () => {
    expect(recordText(timeoutRecord({ watchdog: 'default', agentId: 'afake0001', time: TIME }))).toBe(
      ['### 2026-10-06T09:05:03Z · default · timeout', '- stopped review afake0001 after 10 min'].join('\n')
    );
    expect(recordText(timeoutRecord({ watchdog: 'default', agentId: null, time: TIME }))).toContain(
      '- stopped review with no agent id after 10 min'
    );
  });

  test('a refused review shows its category, a failed one its error (§12.3 item 10, §12.4)', () => {
    const review = reviewRecord({
      watchdog: DEFAULT_WATCHDOG,
      agentId: 'afake0001',
      time: TIME,
      end: END,
      trace: TRACE,
    });
    const refused = { ...review, reason: 'refusal', refusal: 'cyber' } as const;
    expect(recordText(refused)).toContain('- error: none\n- refused: cyber\n');
    expect(recordText({ ...refused, refusal: null })).toContain('- refused: no category');
    expect(recordText({ ...review, reason: 'error', error: 'Credit balance is too low' })).toContain(
      '- error: Credit balance is too low\n- notes'
    );
  });

  test('the path is <config>/watchdog/dumps/<sessionId>-<YYYYMMDD-HHmmss>.md in UTC', () => {
    expect(dumpPath('/cfg', 'sess-1', TIME)).toBe('/cfg/watchdog/dumps/sess-1-20261006-090503.md');
  });

  test('dump raw adds the prompts; a plain dump has none', () => {
    const input = { sessionId: 'sess-1', time: TIME, lines: ['on source: /watchdog on'], records: [record()] };
    const plain = dumpText(input);
    const raw = dumpText({ ...input, prompts: [{ watchdog: 'default', prompt: 'New updates:\n\nuser: Fix it.' }] });
    expect(plain).toContain('- on source: /watchdog on');
    expect(plain).toContain(recordText(record()));
    expect(plain).not.toContain('## Prompts');
    expect(raw).toContain('## Prompts of the last reviews\n\n### default\n\n> New updates:\n>\n> user: Fix it.');
    expect(dumpText({ ...input, prompts: [] })).toContain('None: a reload of the plugin clears them.');
  });
});
