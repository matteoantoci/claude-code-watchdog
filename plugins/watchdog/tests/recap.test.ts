import { describe, expect, test } from 'claude-code/testing';
import { closeUpdate, backlogBatch, recordRow, startFeed } from '../hooks/feed/feed';
import { reviewPrompt } from '../hooks/review/prompt';
import type { Update, UpdateClose } from '../hooks/feed/feed';
import type { RecapNote } from '../hooks/note/history';
import type { ReviewInput } from '../hooks/review/prompt';
import type { ApiMessage, SessionAppendInput } from 'claude-code';

const user = (...texts: string[]): ApiMessage => ({
  role: 'user',
  content: texts.map((text) => ({ type: 'text', text })),
});

const reads = (...ids: string[]): ApiMessage => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/${id}.ts` } })),
});

const results = (...ids: string[]): ApiMessage => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'one\ntwo' })),
});

const updatesOf = (rows: readonly SessionAppendInput[], close: UpdateClose = 'turn'): readonly Update[] =>
  backlogBatch(closeUpdate(rows.reduce(recordRow, startFeed(['default'])), close), 'default')?.updates ?? [];

const ASK: SessionAppendInput = {
  uuid: 'u9',
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Now add tests.' }] },
};

// One closed update of the primary agent: the person asks.
const UPDATES = updatesOf([ASK]);

const input = (extra: Partial<ReviewInput>): ReviewInput => ({
  updates: UPDATES,
  notes: [],
  messages: [],
  prompts: 0,
  skip: new Set(),
  ...extra,
});

const NOTES: readonly RecapNote[] = [
  { text: 'Check the null date.', severity: 'concern', delivery: 'steered' },
  { text: 'Name the helper parseDate.', severity: 'nit', delivery: 'aside on next prompt' },
];

describe('spawn prompt', () => {
  test('a first review has only the new updates, under omp `### Session update`', () => {
    expect(reviewPrompt(input({}))).toBe('### Session update\n\n**user**:\nNow add tests.');
  });

  test('the 4 parts come in order, each newest first', () => {
    const prompt = reviewPrompt(
      input({
        notes: NOTES,
        messages: [user('Fix the parser.'), reads('toolu_1'), results('toolu_1'), user('Now add tests.')],
        prompts: 2,
      })
    );
    expect(prompt).toBe(
      [
        '### Your notes so far (newest first)',
        '',
        '- [nit] Name the helper parseDate. (aside on next prompt)',
        '- [concern] Check the null date. (steered)',
        '',
        "### The person's prompts since the watchdog started (newest first)",
        '',
        '**user**:\nNow add tests.',
        '',
        '**user**:\nFix the parser.',
        '',
        '### Earlier updates (newest first, one line for each tool call)',
        '',
        '→ Read(/repo/toolu_1.ts) ⇒ ok · 2 lines',
        '',
        '### Session update',
        '',
        '**user**:\nNow add tests.',
      ].join('\n')
    );
  });

  test('the compact prompt of a too-long retry collapses every update and has no older updates', () => {
    const updates = updatesOf(
      [
        ASK,
        {
          uuid: 'a9',
          door: 'response',
          origin: { kind: 'model', model: 'claude-opus-4-5' },
          message: {
            type: 'assistant',
            role: 'assistant',
            content: [
              { type: 'text', text: 'I read a.ts first.' },
              { type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/repo/a.ts' } },
            ],
          },
        },
      ],
      'step'
    );
    const prompt = reviewPrompt(
      input({ updates, notes: NOTES, messages: [user('Now add tests.'), reads('toolu_1')], prompts: 1 }),
      { isCompact: true }
    );
    expect(prompt).toContain('### Your notes so far (newest first)\n\n- [nit]');
    expect(prompt).toContain("### The person's prompts since the watchdog started (newest first)");
    expect(prompt).not.toContain('### Earlier updates');
    expect(prompt).toMatch(
      /### Session update\n\n\*\*user\*\*:\nNow add tests\.\n\n\*\*agent\*\*:\n→ Read\(\/repo\/a\.ts\) ⇒ pending\n\[… \d+ chars elided …\]\n\n---\n\n\[in progress — more steps follow\]$/u
    );
  });
});

describe("recap part 2: the person's prompts", () => {
  test('only person prompts since the watchdog started, in full; engine and plugin text is left out', () => {
    const prompt = reviewPrompt(
      input({
        messages: [
          user('Before the watchdog.'),
          user('<system-reminder>\nContext.\n</system-reminder>', 'Fix the parser.\nKeep the API.'),
          user('<task-notification>\n<task-id>a1</task-id>\n</task-notification>'),
          user('The watchdog plugin sent a message:\nLook again.'),
          results('toolu_1'),
          user('[Request interrupted by user]'),
          user('Now add tests.'),
        ],
        prompts: 2,
      })
    );
    expect(prompt).toContain('**user**:\nNow add tests.\n\n**user**:\nFix the parser.\nKeep the API.\n\n###');
    expect(prompt).not.toMatch(/Before the watchdog|Context\.|task-id|Look again|interrupted/u);
  });

  test('a person prompt that starts with a tag of its own is typed text; only the engine tags are left out', () => {
    const prompt = reviewPrompt(
      input({
        messages: [
          user('Before the watchdog.'),
          user('<div> is misaligned on mobile.'),
          user('<command-name>/watchdog</command-name>'),
          user('<local-command-stdout>watchdog on</local-command-stdout>'),
          user('<context>The login page.</context>'),
        ],
        prompts: 2,
      })
    );
    expect(prompt).toContain(
      '**user**:\n<context>The login page.</context>\n\n**user**:\n<div> is misaligned on mobile.\n\n###'
    );
    expect(prompt).not.toMatch(/Before the watchdog|command-name|local-command/u);
  });

  test('over 20,000 chars, the oldest prompts go with a count; the newest stays whole even when longer', () => {
    const long = 'n'.repeat(25_000);
    const prompt = reviewPrompt(
      input({ messages: [user('Oldest.'), user('m'.repeat(10_000)), user(long)], prompts: 3 })
    );
    expect(prompt).toContain(`**user**:\n${long}\n\n[2 earlier prompts omitted]`);
  });
});

describe('recap part 3: older updates', () => {
  test('one line for each tool call, newest update first; the calls of the new updates are left out', () => {
    const prompt = reviewPrompt(
      input({
        messages: [
          user('Fix the parser.'),
          reads('toolu_1', 'toolu_2'),
          results('toolu_1', 'toolu_2'),
          reads('toolu_3'),
          results('toolu_3'),
          reads('toolu_4'),
        ],
        prompts: 1,
        skip: new Set(['toolu_4']),
      })
    );
    expect(prompt).toContain(
      [
        '→ Read(/repo/toolu_3.ts) ⇒ ok · 2 lines',
        '',
        '→ Read(/repo/toolu_1.ts) ⇒ ok · 2 lines',
        '→ Read(/repo/toolu_2.ts) ⇒ ok · 2 lines',
        '',
        '### Session update',
      ].join('\n')
    );
    expect(prompt).not.toContain('toolu_4');
  });

  test('over 30,000 chars, the oldest updates go with `[N earlier updates omitted]`', () => {
    const ids = Array.from({ length: 1000 }, (_, n) => `toolu_${String(n).padStart(4, '0')}`);
    const messages = [user('Fix the parser.'), ...ids.flatMap((id) => [reads(id), results(id)])];
    const prompt = reviewPrompt(input({ messages, prompts: 1 }));
    const part = prompt.split('### Earlier updates (newest first, one line for each tool call)\n\n')[1] ?? '';
    const shown = part.split('\n\n').filter((entry) => entry.startsWith('→ Read'));
    expect(part).toContain(`\n\n[${1000 - shown.length} earlier updates omitted]\n\n### Session update`);
    expect(shown[0]).toContain('toolu_0999');
    expect(shown.join('\n\n').length).toBeLessThanOrEqual(30_000);
  });
});
