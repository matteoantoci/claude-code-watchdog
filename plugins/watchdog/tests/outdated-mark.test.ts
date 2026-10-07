import { describe, expect, test } from 'claude-code/testing';
import { recordRow, setFeed, startFeed } from '../hooks/feed/feed';
import { editsSince, isNamed } from '../hooks/note/outdated';
import { mainRow } from './fixtures/session';
import type { SessionAppendInput } from 'claude-code';

const CART = '/repo/cart.py';
const BLOCKER = 'cart.py line 3 still subtracts the percent.';

// One response row with one tool call.
const call = (id: string, name: string, input: unknown): SessionAppendInput => ({
  ...mainRow(`row-${id}`, 'assistant', ''),
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

describe('§10.8 the outdated mark', () => {
  test('the base name or the path of a file counts; a name inside a longer name does not', () => {
    expect(isNamed(BLOCKER, CART)).toBe(true);
    expect(isNamed('In `/repo/cart.py`, line 3.', CART)).toBe(true);
    expect(isNamed('Fix src/cart.py.', CART)).toBe(true);
    expect(isNamed('mycart.py subtracts.', CART)).toBe(false);
    expect(isNamed('cart.pyc is stale.', CART)).toBe(false);
    expect(isNamed('cart.py.bak is stale.', CART)).toBe(false);
    expect(isNamed('cart_py is fine.', CART)).toBe(false);
  });

  test('a feed row of an Edit, Write, MultiEdit or NotebookEdit call keeps its file; another call keeps none', () => {
    const rows = [
      call('t1', 'Edit', { file_path: CART, old_string: 'a', new_string: 'b' }),
      call('t2', 'Write', { file_path: '/repo/new.py', content: '' }),
      call('t3', 'MultiEdit', { file_path: CART, edits: [] }),
      call('t4', 'NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' }),
      call('t5', 'Read', { file_path: CART }),
    ];
    const feed = rows.reduce(recordRow, startFeed(['default']));
    expect(feed.rows.map((row) => row.edit)).toEqual([CART, '/repo/new.py', CART, '/repo/n.ipynb', undefined]);
  });

  test('only the edit calls after the batch on a named file count; a batch end that left the feed lies before it', () => {
    setFeed({
      ...startFeed(['default']),
      rows: [
        { uuid: 'e0', text: '', edit: CART },
        { uuid: 'a1', text: 'Done.' },
        { uuid: 'e1', text: '', edit: CART },
        { uuid: 'e2', text: '', edit: '/repo/util.py' },
      ],
    });
    expect(editsSince({ text: BLOCKER, batchEnd: 'a1' })).toBe(1);
    expect(editsSince({ text: BLOCKER, batchEnd: 'gone' })).toBe(2);
    expect(editsSince({ text: BLOCKER, batchEnd: null })).toBe(0);
    expect(editsSince({ text: 'util.py has no test.', batchEnd: 'a1' })).toBe(1);
    expect(editsSince({ text: BLOCKER, batchEnd: 'a1', subagentId: 'asub0001' })).toBe(0);
  });
});
