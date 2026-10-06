import { describe, expect, test } from 'claude-code/testing';
import { applyBacklog } from '../hooks/failure/backlog';
import { closeUpdate, backlogBatch, recordRow, startFeed } from '../hooks/feed/feed';
import type { Feed } from '../hooks/feed/feed';

// One closed update of one agent row.
const update = (feed: Feed, uuid: string): Feed =>
  closeUpdate(
    recordRow(feed, {
      uuid,
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-4-5' },
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `row ${uuid}` }] },
    }),
    'turn'
  );

const texts = (feed: Feed, slug: string): string[] =>
  backlogBatch(feed, slug)?.rows.map((row) => `row ${row.uuid}`) ?? [];

// The feed of two watchdogs after the first review of `a` took updates u1 and u2.
const reviewed = (): Feed => update(update(startFeed(['a', 'b']), 'u1'), 'u2');

describe('§12.3 item 1: requeue', () => {
  test('a failed review with no notes puts its updates back at the front; the next review takes them merged', () => {
    const kept = applyBacklog(reviewed(), { slug: 'a', batchEnd: 'u2' }, 'keep');
    expect(texts(update(kept, 'u3'), 'a')).toEqual(['row u1', 'row u2', 'row u3']);
  });

  test('a review that keeps its notes moves the cursor past its batch', () => {
    const moved = applyBacklog(reviewed(), { slug: 'a', batchEnd: 'u2' }, 'move');
    expect(texts(update(moved, 'u3'), 'a')).toEqual(['row u3']);
    expect(texts(update(moved, 'u3'), 'b')).toEqual(['row u1', 'row u2', 'row u3']);
  });

  test('a halt drops the whole backlog; the updates since the halt wait for the try', () => {
    const later = update(reviewed(), 'u3');
    const dropped = applyBacklog(later, { slug: 'a', batchEnd: 'u2' }, 'drop');
    expect(texts(dropped, 'a')).toEqual([]);
    expect(texts(update(update(dropped, 'u4'), 'u5'), 'a')).toEqual(['row u4', 'row u5']);
  });

  test('no_model and blocked take the watchdog out of the feed, the other watchdog keeps its backlog', () => {
    const forgotten = applyBacklog(reviewed(), { slug: 'a', batchEnd: 'u2' }, 'forget');
    expect(Object.keys(forgotten.cursors)).toEqual(['b']);
    expect(texts(forgotten, 'b')).toEqual(['row u1', 'row u2']);
  });
});
