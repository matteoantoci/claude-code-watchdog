import { describe, expect, test } from 'claude-code/testing';
import { MESSAGES_READ_CAP } from '../hooks/constants';
import { closeUpdate, pendingBatch, recordRow, startFeed } from '../hooks/feed/feed';
import { clearGuardKeys } from '../hooks/note/history';
import { renderBatch } from '../hooks/review/batch';
import { isRewound, markOf, rewindFeed } from '../hooks/rewind/mark';
import { changeKind } from '../hooks/session/change';
import { replayFeed } from '../hooks/session/replay';
import { mainRow } from './fixtures/session';
import type { ApiMessage, SessionMessage } from 'claude-code';

const said = (role: 'user' | 'assistant', text: string, ...ids: string[]): SessionMessage => ({
  role,
  text,
  toolUses: ids.map((id) => ({ tool_use_id: id, tool: 'Read', input: { file_path: `/repo/${id}.ts` } })),
});

// The conversation at a boundary: two turns, the second with a Read.
const TWO_TURNS: readonly SessionMessage[] = [
  said('user', 'Task 1.'),
  said('assistant', 'Done 1.'),
  said('user', 'Task 2.'),
  said('assistant', '', 'toolu_1'),
];

// A conversation as `$.session.messages({ as: 'api' })` gives it: an earlier turn, then the last person prompt,
// a Read, the watchdog's own steer and the answer.
const CONVERSATION: readonly ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Task A.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done A.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Task B.' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/b.ts' } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const b = 1;' },
      { type: 'text', text: '<watchdog-notes>\nCheck b.\n</watchdog-notes>' },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Done B.' }] },
];

describe('§14.3 session change', () => {
  test('the command that wraps `session.end` tells /branch from /resume', () => {
    expect(changeKind('clear', 'clear')).toBe('clear');
    expect(changeKind('resume', 'resume')).toBe('resume');
    expect(changeKind('branch', 'resume')).toBe('branch');
    expect(changeKind(undefined, 'resume')).toBe('resume');
  });

  test('the replay runs from the last person prompt to the end, after the marker, without own notes', () => {
    const batch = pendingBatch(replayFeed(startFeed(['default']), CONVERSATION, 'replay:s2'), 'default');
    const text = renderBatch(batch?.updates ?? []);

    expect(batch?.updates).toHaveLength(1);
    expect(text).toMatch(
      /^\[earlier history, before the watchdog started\]\n\n\*\*user\*\*:\nTask B\.\n\n\*\*agent\*\*:\n→ Read\(\/repo\/b\.ts\) ⇒ ok[\s\S]*export const b = 1;[\s\S]*Done B\.$/u
    );
    expect(text).not.toMatch(/Task A\.|Done A\.|Check b\./u);
  });

  test('a conversation with no person prompt replays nothing', () => {
    const feed = startFeed(['default']);
    expect(replayFeed(feed, CONVERSATION.slice(3), 'replay:s2')).toBe(feed);
  });
});

describe('§14.4 rewind', () => {
  test('a conversation that only grew keeps the message at the mark', () => {
    const mark = markOf(TWO_TURNS);
    expect(isRewound(mark, [...TWO_TURNS, said('user', ''), said('assistant', 'Done 2.')])).toBe(false);
    expect(isRewound(undefined, [])).toBe(false);
  });

  test('a restore that shrank the conversation, or put another message at the mark, is a rewind', () => {
    const mark = markOf(TWO_TURNS);
    expect(isRewound(mark, TWO_TURNS.slice(0, 2))).toBe(true);
    expect(isRewound(mark, [...TWO_TURNS.slice(0, 3), said('assistant', '', 'toolu_9')])).toBe(true);
    expect(isRewound(mark, [...TWO_TURNS.slice(0, 2), said('user', 'Task 3.'), said('assistant', 'Done 3.')])).toBe(
      true
    );
  });

  test('at the 4096 read cap the list slides: the marked message counts while any message has its hash', () => {
    const full = Array.from({ length: MESSAGES_READ_CAP }, (_, n) => said(n % 2 === 0 ? 'user' : 'assistant', `m${n}`));
    const mark = markOf(full);
    expect(isRewound(mark, [...full.slice(2), said('user', 'next'), said('assistant', 'ok')])).toBe(false);
    expect(isRewound(mark, full.slice(0, -1))).toBe(true);
  });

  test('the backlog goes; the update that runs stays for the next review, after the marker', () => {
    const rows = [mainRow('u1', 'user', 'Task 1.'), mainRow('a1', 'assistant', 'Done 1.')];
    const closed = closeUpdate(rows.reduce(recordRow, startFeed(['default'])), 'turn');
    const feed = rewindFeed([mainRow('u2', 'user', 'Task 2.')].reduce(recordRow, closed), 'rewind:1');
    const batch = pendingBatch(closeUpdate(feed, 'turn'), 'default');
    expect(renderBatch(batch?.updates ?? [])).toBe('[user rewound the conversation]\n\n**user**:\nTask 2.');
  });

  test('§9.6: a rewind clears the guard keys and keeps the recap notes', () => {
    const note = { text: 'Check b.', severity: 'concern', delivery: 'steered' } as const;
    const history = {
      watchdogs: { default: { keys: [{ key: 'check b', severity: 'concern' }], notes: [note] } },
      lastUsed: 5,
    } as const;
    expect(clearGuardKeys(history)).toEqual({ watchdogs: { default: { keys: [], notes: [note] } }, lastUsed: 5 });
  });
});
