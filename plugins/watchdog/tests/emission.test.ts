import { describe, expect, test } from 'claude-code/testing';
import { readHistory, watchdogNotes } from '../hooks/note/history';
import { NOW, REVIEW_AGENT, SESSION_ID, START, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

const NOTE = 'mcp__watchdog__note';
const STORE_KEY = `notes:${SESSION_ID}`;
const UNSAFE_ROW = 'watchdog: dropped a note with a destructive command';

// The engine's `agent.spawn` of a review, as the Agent tool fires it: the mod learns the id from `next(e)`.
const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_plugin_00000000000000000000000000000001',
  prompt: 'review',
  description: 'watchdog default review',
  subagentType: 'watchdog:default',
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

// One review of a batch with one user row: on, the row, a main turn end that spawns the review, its id.
const reviewOf = async ($: Engine, text: string): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.session.append(mainRow('u1', 'user', text)).catch(() => undefined);
  await $.turn.complete(turnEnd('t1'));
  await $.agent.spawn(SPAWN);
};

const note = async ($: Engine, text: string, severity: string) =>
  $.tool.call({ tool: NOTE, agentId: REVIEW_AGENT, note: text, severity });

describe('the note hook: destructive check, emission guard and note history', () => {
  test('one review: unsafe drop, admission, duplicate, a held nit raised in place to a steer, noise; the history is stored', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await reviewOf($, 'Speed up the build.');
    const logsBefore = seen.logs.length;

    expect(await note($, 'Run rm -rf build/ before the next try.', 'concern')).toEqual({
      result: 'Dropped: unsafe note.',
    });
    expect(seen.store.has(STORE_KEY)).toBe(false);
    expect(await note($, 'Missing null check in parse().', 'nit')).toEqual({ result: 'Queued. Do not re-raise.' });
    expect(await note($, 'missing null check in PARSE', 'nit')).toEqual({ result: 'Dropped: already raised.' });
    expect(await note($, 'Missing null check in parse()!', 'concern')).toEqual({ result: 'Queued. Do not re-raise.' });
    expect(await note($, 'LGTM.', 'nit')).toEqual({ result: 'Dropped: nothing actionable.' });
    expect(await note($, '  ', 'blocker')).toEqual({ result: 'Dropped: empty note.' });

    expect(seen.logs.slice(logsBefore)).toEqual([
      UNSAFE_ROW,
      '[nit] default: Missing null check in parse(). (held)',
      '[concern] default: Missing null check in parse(). (steered)',
    ]);
    expect(seen.store.get(STORE_KEY)).toEqual({
      watchdogs: {
        default: {
          keys: [{ key: 'missing null check in parse', severity: 'concern' }],
          notes: [{ text: 'Missing null check in parse().', severity: 'concern', delivery: 'steered' }],
        },
      },
      lastUsed: NOW,
    });
  });

  test('a destructive command that the batch holds too passes the check', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await reviewOf($, 'Clean with rm -rf dist, then rebuild.');
    const logsBefore = seen.logs.length;
    expect(await note($, 'rm -rf dist also deletes the checked-in fixtures.', 'blocker')).toEqual({
      result: 'Queued. Do not re-raise.',
    });
    expect(seen.logs.slice(logsBefore)).toEqual([
      '[blocker] default: rm -rf dist also deletes the checked-in fixtures. (steered)',
    ]);
  });

  test('the stored history loads at the first note hook, so an old key is a duplicate', async ($, on: SessionStubs) => {
    const stored = {
      watchdogs: { default: { keys: [{ key: 'missing null check', severity: 'concern' }], notes: [] } },
      lastUsed: 1,
    };
    stubSession(on, { store: new Map([[STORE_KEY, stored]]) });
    await reviewOf($, 'Fix the parser.');
    expect(await note($, 'Missing null check.', 'concern')).toEqual({ result: 'Dropped: already raised.' });
    expect(await note($, 'Missing null check.', 'blocker')).toEqual({ result: 'Queued. Do not re-raise.' });
  });

  test('a refused store write keeps the note and shows one row for the session', async ($, on: SessionStubs) => {
    const seen = stubSession(on, { storeSetDeny: 'store is over 4 MiB' });
    await reviewOf($, 'Fix the parser.');
    const logsBefore = seen.logs.length;
    expect(await note($, 'First note.', 'nit')).toEqual({ result: 'Queued. Do not re-raise.' });
    expect(await note($, 'Second note.', 'nit')).toEqual({ result: 'Queued. Do not re-raise.' });
    expect(await note($, 'first note', 'nit')).toEqual({ result: 'Dropped: already raised.' });
    const rows = seen.logs
      .slice(logsBefore)
      .filter((row) => row.startsWith('watchdog: the note history was not saved: '));
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('store is over 4 MiB');
  });

  test('a full budget: a concern displaces the oldest held nit, which the history marks `displaced`', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await reviewOf($, 'Fix the parser.');
    const queued = { result: 'Queued. Do not re-raise.' };
    expect(await note($, 'Nit one.', 'nit')).toEqual(queued);
    expect(await note($, 'Nit two.', 'nit')).toEqual(queued);
    expect(await note($, 'Nit three.', 'nit')).toEqual(queued);
    expect(await note($, 'Nit four.', 'nit')).toEqual(queued);
    expect(await note($, 'Nit five.', 'nit')).toEqual({ result: "Dropped: this review's note budget is spent." });
    expect(await note($, 'The parser drops the last token.', 'concern')).toEqual(queued);
    expect(await note($, 'The cache key ignores the locale.', 'concern')).toEqual(queued);
    expect(await note($, 'The build skips the parser tests.', 'blocker')).toEqual(queued);

    const { notes } = watchdogNotes(readHistory(seen.store.get(STORE_KEY)), 'default');
    expect(notes.map(({ text, delivery }) => `${text} ${delivery}`)).toEqual([
      'Nit one. displaced',
      'Nit two. displaced',
      'Nit three. held',
      'Nit four. held',
      'The parser drops the last token. steered',
      'The cache key ignores the locale. steered',
      'The build skips the parser tests. steered',
    ]);
  });
});
