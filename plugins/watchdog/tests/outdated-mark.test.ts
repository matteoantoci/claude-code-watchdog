import { describe, expect, test } from 'claude-code/testing';
import { cardKey } from '../hooks/band/cards';
import { recordRow, setFeed, startFeed } from '../hooks/feed/feed';
import { editsSince, outdatedMark } from '../hooks/note/outdated';
import { noteId } from '../hooks/note/retract';
import { mainRow } from './fixtures/session';
import type { SessionAppendInput } from 'claude-code';

const CART = '/repo/cart.py';

// One response row with one tool call.
const call = (id: string, name: string, input: unknown): SessionAppendInput => ({
  ...mainRow(`row-${id}`, 'assistant', ''),
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

describe('§10.8 the outdated mark', () => {
  test('a feed row of an Edit, Write, MultiEdit or NotebookEdit call is an edit row; another call is not', () => {
    const rows = [
      call('t1', 'Edit', { file_path: CART, old_string: 'a', new_string: 'b' }),
      call('t2', 'Write', { file_path: '/repo/new.py', content: '' }),
      call('t3', 'MultiEdit', { file_path: CART, edits: [] }),
      call('t4', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' }),
      call('t5', 'Read', { file_path: CART }),
    ];
    const feed = rows.reduce(recordRow, startFeed(['default']));
    expect(feed.rows.map((row) => row.edit)).toEqual([true, true, true, true, undefined]);
  });

  test('each edit row after the batch counts, whatever file it edits; a batch end that left the feed lies before it', () => {
    setFeed({
      ...startFeed(['default']),
      rows: [
        { uuid: 'e0', text: '', edit: true },
        { uuid: 'a1', text: 'Done.' },
        { uuid: 'e1', text: '', edit: true },
        { uuid: 'r1', text: '→ Read(/repo/cart.py)' },
        { uuid: 'e2', text: '', edit: true },
      ],
    });
    expect(editsSince({ batchEnd: 'a1' })).toBe(2);
    expect(editsSince({ batchEnd: 'e2' })).toBe(0);
    expect(editsSince({ batchEnd: 'gone' })).toBe(3);
    expect(editsSince({ batchEnd: null })).toBe(0);
    expect(editsSince({ batchEnd: 'a1', subagentId: 'asub0001' })).toBe(0);
  });

  test('the card and the recap show the mark from 1 edit on', () => {
    expect([0, 1, 2].map((edits) => outdatedMark(edits))).toEqual([
      undefined,
      'may be outdated: 1 edit since',
      'may be outdated: 2 edits since',
    ]);
  });
});

describe('§10.8 the id of an open note', () => {
  test('4 base-36 digits from the card key: the watchdog, the watched agent and the normalized text', () => {
    const note = { watchdog: 'default', text: 'apply_discount subtracts the percent.' };
    const id = noteId(cardKey(note));
    expect(id).toMatch(/^[0-9a-z]{4}$/u);
    expect(noteId(cardKey({ ...note, text: 'Apply_discount  subtracts the percent!' }))).toBe(id);
    expect(noteId(cardKey({ ...note, watchdog: 'security' }))).not.toBe(id);
    expect(noteId(cardKey({ ...note, subagent: { agentId: 'asub0001', type: 'Explore' } }))).not.toBe(id);
  });
});
