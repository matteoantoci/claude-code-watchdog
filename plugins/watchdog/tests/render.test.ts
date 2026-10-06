import { describe, expect, test } from 'claude-code/testing';
import { addServerToolUses, closeUpdate, backlogBatch, recordRow, startFeed } from '../hooks/feed/feed';
import { renderBatch } from '../hooks/review/batch';
import type { Feed } from '../hooks/feed/feed';
import type { ApiContentBlock, SessionAppendInput, SessionAppendOrigin, TurnStepServerToolUse } from 'claude-code';

const MODEL: SessionAppendOrigin = { kind: 'model', model: 'claude-opus-4-5' };

const person = (uuid: string, text: string): SessionAppendInput => ({
  uuid,
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
});

const response = (uuid: string, block: ApiContentBlock): SessionAppendInput => ({
  uuid,
  door: 'response',
  origin: MODEL,
  message: { type: 'assistant', role: 'assistant', content: [block] },
});

const call = (id: string, name: string, input: unknown): SessionAppendInput =>
  response(`row-${id}`, { type: 'tool_use', id, name, input });

// The engine names the called tool in a result row's origin.
const result = (
  id: string,
  content: unknown,
  extra: { isError?: boolean; tool?: string } = {}
): SessionAppendInput => ({
  uuid: `result-${id}`,
  door: 'tool-result',
  origin: { kind: 'tool', tool: extra.tool ?? 'Read' },
  message: {
    type: 'user',
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: extra.isError === true }],
  },
});

const textOf = (rows: readonly SessionAppendInput[], feed: Feed = startFeed(['default'])): string => {
  const recorded = rows.reduce(recordRow, feed);
  const batch = backlogBatch(closeUpdate(recorded, 'turn'), 'default');
  return batch === undefined ? '' : renderBatch(batch.updates);
};

describe('update rendering (omp formatSessionHistoryMarkdown, watched roles)', () => {
  test('a person prompt and the agent text show under the omp labels; one label covers a run of rows', () => {
    const text = textOf([
      person('u1', 'Fix the date parser.'),
      response('a1', { type: 'text', text: 'I will read parse.ts.' }),
      response('a2', { type: 'text', text: 'Then edit it.' }),
    ]);
    expect(text).toBe('**user**:\nFix the date parser.\n\n**agent**:\nI will read parse.ts.\n\nThen edit it.');
  });

  test('a tool call and its result become one omp line, with the result fenced under `Tool result:`', () => {
    const text = textOf([
      call('toolu_1', 'Read', { file_path: '/repo/parse.ts' }),
      result('toolu_1', 'export const parse = 1;\nexport default parse;'),
    ]);
    expect(text).toBe(
      [
        '**agent**:',
        '→ Read(/repo/parse.ts) ⇒ ok · 2 lines',
        'Tool result:',
        '```text',
        'export const parse = 1;\nexport default parse;',
        '```',
      ].join('\n')
    );
  });

  test('an error result shows its first line; a call with no result yet is pending', () => {
    const text = textOf([
      call('toolu_1', 'Bash', { command: 'npm test', description: 'Run the tests' }),
      result('toolu_1', [{ type: 'text', text: 'Exit code 1\nFAIL parse.test.ts' }], { isError: true }),
      call('toolu_2', 'Read', { file_path: '/repo/b.ts' }),
    ]);
    expect(text).toContain(
      '→ Bash({"command":"npm test","description":"Run the tests"}) ⇒ error · 2 lines — Exit code 1\nTool result:'
    );
    expect(text).toContain('→ Read(/repo/b.ts) ⇒ pending');
  });

  test('`AskUserQuestion` shows its input under `Ask input:`, and the answer is never cut', () => {
    const questions = [{ question: 'Which parser?', header: 'Parser', options: [{ label: 'date-fns' }] }];
    const answer = `User has answered your questions: "Which parser?"="${'mine '.repeat(1000)}"`;
    const text = textOf([
      call('toolu_1', 'AskUserQuestion', { questions }),
      result('toolu_1', answer, { tool: 'AskUserQuestion' }),
    ]);
    expect(text).toContain(`Ask input:\n\`\`\`json\n${JSON.stringify({ questions }, null, 2)}\n\`\`\``);
    expect(text).toContain(answer);
    expect(text).not.toContain('elided');
  });

  test('`thinking` shows only with text; a redacted block shows as `[thinking redacted]`', () => {
    const text = textOf([
      response('a1', { type: 'thinking', thinking: '', signature: 'sig' }),
      response('a2', { type: 'thinking', thinking: 'I check the parser first.', signature: 'sig' }),
      response('a3', { type: 'redacted_thinking', data: 'opaque' }),
    ]);
    expect(text).toBe('**agent**:\n_thinking:_ I check the parser first.\n\n[thinking redacted]');
  });

  test('a compaction row shows its summary in `<primary-context kind="compaction">`, XML-escaped', () => {
    const text = textOf([
      {
        uuid: 'c1',
        door: 'compaction',
        origin: { kind: 'engine' },
        message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'Summary: a < b & c' }] },
      },
    ]);
    expect(text).toBe('<primary-context kind="compaction">\nSummary: a &lt; b &amp; c\n</primary-context>');
  });

  test('rows from other plugins, attachments, hook context, notices and task notifications are one line each', () => {
    const long = `first line\n${'word '.repeat(60)}`;
    const text = textOf([
      { ...person('p1', long), origin: { kind: 'plugin', name: 'other' } },
      { ...person('p2', long), origin: { kind: 'task-notification' } },
      {
        uuid: 'at1',
        door: 'attachment',
        origin: { kind: 'engine' },
        message: { type: 'attachment', name: 'nested_memory', content: [{ type: 'text', text: long }] },
      },
      {
        uuid: 'h1',
        door: 'hook-context',
        origin: { kind: 'hook', event: 'SessionStart' },
        message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: long }] },
      },
      {
        uuid: 'n1',
        door: 'notice',
        origin: { kind: 'engine' },
        message: { type: 'system', name: 'local_command', content: [{ type: 'text', text: 'Set model to opus' }] },
      },
    ]);
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines.length).toBe(5);
    expect(lines[0]?.startsWith('[plugin other] first line word word')).toBe(true);
    expect(lines[0]?.length).toBe(120 + '[plugin other] '.length);
    expect(lines[1]?.startsWith('[task-notification] first line')).toBe(true);
    expect(lines[2]?.startsWith('[attachment nested_memory] first line')).toBe(true);
    expect(lines[3]?.startsWith('[hook SessionStart] first line')).toBe(true);
    expect(lines[4]).toBe('[notice local_command] Set model to opus');
  });

  test('a server tool call and its result are one line each, also when only `turn.step` names the call', () => {
    const fromRows = textOf([
      response('a1', {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'advisor',
        input: { question: 'Is it safe?' },
      }),
      response('a2', { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { text: 'Yes, it is.' } }),
    ]);
    expect(fromRows).toBe('**agent**:\n→ advisor(Is it safe?)\n\n⇒ advisor_tool_result: {"text":"Yes, it is."}');

    const use: TurnStepServerToolUse = { id: 'srvtoolu_2', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 };
    const seen: TurnStepServerToolUse = { ...use, id: 'srvtoolu_1' };
    const recorded = [
      response('a1', {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'advisor',
        input: { question: 'Is it safe?' },
      }),
    ].reduce(recordRow, startFeed(['default']));
    const fromStep = textOf([], addServerToolUses(recorded, [seen, use]));
    expect(fromStep).toBe('**agent**:\n→ advisor(Is it safe?)\n\n→ advisor({})\n⇒ advisor: done');
  });
});

describe('update caps', () => {
  test('a tool result keeps 4,000 chars, head and tail, with the elided count between them', () => {
    const output = `${'h'.repeat(3000)}${'m'.repeat(1000)}${'t'.repeat(3000)}`;
    const text = textOf([call('toolu_1', 'Read', { file_path: '/repo/big.ts' }), result('toolu_1', output)]);
    expect(text).toContain(`\n${'h'.repeat(2000)}[… 3000 chars elided …]${'t'.repeat(2000)}\n`);
    expect(text).toContain('⇒ ok · 1 line');
  });

  test('a tool input keeps 8,000 chars', () => {
    const content = 'x'.repeat(10_000);
    const text = textOf([call('toolu_1', 'Write', { file_path: '/repo/a.ts', content })]);
    const head = text.split('\n')[1] ?? '';
    expect(head).toContain('[… ');
    expect(head).toContain(' chars elided …]');
    expect(head.length).toBeLessThan(8000 + 100);
  });

  test('`thinking` keeps 8,000 chars', () => {
    const thinking = 'y'.repeat(9000);
    const text = textOf([response('a1', { type: 'thinking', thinking, signature: 'sig' })]);
    expect(text).toContain(`_thinking:_ ${'y'.repeat(4000)}[… 1000 chars elided …]${'y'.repeat(4000)}`);
  });

  test('text that the person typed is never cut', () => {
    const typed = 'p'.repeat(130_000);
    const text = textOf([person('u1', typed)]);
    expect(text).toBe(`**user**:\n${typed}`);
  });
});
