import { describe, expect, test } from 'claude-code/testing';
import { cardKey } from '../hooks/band/cards';
import { batchClose, closeUpdate, moveCursor, recordRow, setFeed, startFeed } from '../hooks/feed/feed';
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
  test('the feed counts each Edit, Write, MultiEdit and NotebookEdit call; a closed update and a cursor move keep it', () => {
    const rows = [
      call('t1', 'Edit', { file_path: CART, old_string: 'a', new_string: 'b' }),
      call('t2', 'Write', { file_path: '/repo/new.py', content: '' }),
      call('t3', 'MultiEdit', { file_path: CART, edits: [] }),
      call('t4', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' }),
      call('t5', 'Read', { file_path: CART }),
    ];
    const feed = closeUpdate(rows.reduce(recordRow, startFeed(['default'])), 'turn', 1);
    expect(feed.edits).toBe(4);
    expect(batchClose(feed, 'row-t5')).toEqual({ uuid: 'row-t5', close: 'turn', turn: 1, edits: 4 });
    const moved = moveCursor(feed, 'default', 'row-t5');
    expect(moved.rows.map((row) => row.uuid)).toEqual(['row-t5']);
    expect(moved.edits).toBe(4);
  });

  test('the edits since a note batch are the feed count less the batch count, whatever file they edit', () => {
    setFeed({ ...startFeed(['default']), edits: 5 });
    expect(editsSince({ batchEdits: 3 })).toBe(2);
    expect(editsSince({ batchEdits: 5 })).toBe(0);
    expect(editsSince({ batchEdits: null })).toBe(0);
    expect(editsSince({ batchEdits: 3, subagentId: 'asub0001' })).toBe(0);
    // A feed that started again (`/watchdog on`, a session change) counts no edit of before.
    setFeed(startFeed(['default']));
    expect(editsSince({ batchEdits: 3 })).toBe(0);
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
