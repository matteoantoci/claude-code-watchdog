import { describe, expect, test } from 'claude-code/testing';
import { closeUpdate, moveCursor, pendingBatch, recordRow, startFeed } from '../hooks/feed/feed';
import { renderBatch } from '../hooks/review/batch';
import type { Feed, UpdateClose } from '../hooks/feed/feed';
import type { SessionAppendInput } from 'claude-code';

const person = (uuid: string, text: string): SessionAppendInput => ({
  uuid,
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
});

const agent = (uuid: string, text: string): SessionAppendInput => ({
  uuid,
  door: 'response',
  origin: { kind: 'model', model: 'claude-opus-4-5' },
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
});

const read = (id: string): SessionAppendInput => ({
  ...agent(`row-${id}`, ''),
  message: {
    type: 'assistant',
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/${id}.ts` } }],
  },
});

// Records the rows of one update and closes it as the boundary does.
const update = (feed: Feed, rows: readonly SessionAppendInput[], close: UpdateClose): Feed =>
  closeUpdate(rows.reduce(recordRow, feed), close);

const batchText = (feed: Feed): string => {
  const batch = pendingBatch(feed, 'default');
  return batch === undefined ? '' : renderBatch(batch.updates);
};

const START = startFeed(['default']);

describe('backlog merge', () => {
  test('all updates that wait merge into one review, oldest first', () => {
    const first = update(START, [person('u1', 'First task.'), agent('a1', 'Done one.')], 'turn');
    const feed = update(first, [person('u2', 'Second task.'), agent('a2', 'Done two.')], 'turn');
    expect(batchText(feed)).toBe(
      '**user**:\nFirst task.\n\n**agent**:\nDone one.\n\n**user**:\nSecond task.\n\n**agent**:\nDone two.'
    );
  });

  test('a reviewed update leaves the next batch', () => {
    const first = update(START, [person('u1', 'First task.')], 'turn');
    const reviewed = moveCursor(first, 'default', 'u1');
    const feed = update(reviewed, [person('u2', 'Second task.')], 'turn');
    expect(batchText(feed)).toBe('**user**:\nSecond task.');
  });
});

describe('markers', () => {
  test('`[in progress — more steps follow]` ends the batch only when its last update closed mid-turn', () => {
    const midTurn = update(START, [person('u1', 'Task.'), agent('a1', 'Step one.')], 'step');
    expect(batchText(midTurn)).toBe(
      '**user**:\nTask.\n\n**agent**:\nStep one.\n\n---\n\n[in progress — more steps follow]'
    );
    const ended = update(midTurn, [agent('a2', 'All done.')], 'turn');
    expect(batchText(ended)).not.toContain('in progress');
  });

  test('a turn end right after a step boundary, with no row between, is the end of the turn', () => {
    const midTurn = update(START, [person('u1', 'Task.')], 'step');
    expect(batchText(closeUpdate(midTurn, 'turn'))).toBe('**user**:\nTask.');
  });

  test('an update that Esc closed gets `[turn interrupted by user]`', () => {
    const interrupted = update(START, [person('u1', 'Task.'), agent('a1', 'Starting.')], 'interrupted');
    const feed = update(interrupted, [person('u2', 'Stop, do this instead.')], 'turn');
    expect(batchText(feed)).toBe(
      '**user**:\nTask.\n\n**agent**:\nStarting.\n\n[turn interrupted by user]\n\n**user**:\nStop, do this instead.'
    );
  });
});

describe('batch cap', () => {
  test('over 120,000 chars, older updates become one line for each tool call; the newest stays whole', () => {
    const older = update(START, [person('u1', 'Refactor.'), agent('a1', 'o'.repeat(70_000)), read('toolu_1')], 'turn');
    const feed = update(older, [person('u2', 'Go on.'), agent('a2', 'n'.repeat(60_000))], 'turn');
    const text = batchText(feed);
    expect(text).not.toContain('o'.repeat(100));
    expect(text).toContain('**user**:\nRefactor.\n\n**agent**:\n→ Read(/repo/toolu_1.ts) ⇒ pending\n[… ');
    expect(text).toContain(' chars elided …]\n\n**user**:\nGo on.');
    expect(text).toContain('n'.repeat(60_000));
    expect(text.length).toBeLessThan(120_000);
  });

  test('a collapsed update keeps the text that the person typed', () => {
    const typed = 'p'.repeat(130_000);
    const older = update(START, [person('u1', typed), agent('a1', 'o'.repeat(5000))], 'turn');
    const feed = update(older, [agent('a2', 'Next.')], 'turn');
    const text = batchText(feed);
    expect(text.startsWith(`**user**:\n${typed}\n[… `)).toBe(true);
    expect(text).toMatch(/^\[… \d+ chars elided …\]$/mu);
    expect(text).not.toContain('ooo');
  });
});
