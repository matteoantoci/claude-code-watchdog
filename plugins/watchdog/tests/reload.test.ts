import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_TIMEOUT_MS } from '../hooks/constants';
import { stubDelivery } from './fixtures/delivery';
import { stubState } from './fixtures/on-state';
import { NOW, REVIEW_AGENT, START, mainRow, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateSeed, StateStubs } from './fixtures/on-state';
import type { WorkspaceFile } from './fixtures/session';
import type { SessionAppendInput, ToolCallResult } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = DeliveryStubs & StateStubs & OnEvents<'agent.list'>;

// An agent of the id set whose review the mod stopped before the reload.
const OLD_AGENT = 'aold0001';
const SUB = 'asub0001';
const DROPPED = 'Dropped: the review was stopped.';
const QUEUED = 'Queued. Do not re-raise.';

// §11.1: `WATCHDOG.json` opts the Explore type in.
const EXPLORE_ON: Record<string, WorkspaceFile> = {
  '/repo/WATCHDOG.json': { text: JSON.stringify({ subagents: { Explore: true } }), mtimeMs: 1 },
};

const row = (uuid: string, text: string): { uuid: string; text: string; brief: string } => ({
  uuid,
  text,
  brief: text,
});

const OLD_RECORD = { kind: 'timeout', watchdog: 'default', agentId: OLD_AGENT, time: NOW - 60_000 };

// The `$.state` an earlier module instance wrote: on by the command, the review of turn 1 spawned 9 min 59 s
// before the reload, and the review of the old agent stopped by its timeout.
const SEED: StateSeed = {
  state: { isOn: true, source: '/watchdog on' },
  values: new Map<string, unknown>([
    [
      'ids',
      [
        { agentId: OLD_AGENT, watchdog: 'default' },
        { agentId: REVIEW_AGENT, watchdog: 'default' },
      ],
    ],
    [
      'reviews',
      {
        running: [
          { watchdog: 'default', agentId: REVIEW_AGENT, spawnedAt: NOW - REVIEW_TIMEOUT_MS + 1000, batchEnd: 'u1' },
        ],
        stops: [{ agentId: OLD_AGENT, reason: 'timeout' }],
      },
    ],
    ['log', [OLD_RECORD]],
    [
      'feed',
      {
        rows: [row('u1', '**user**:\nTask 1.')],
        ends: [{ uuid: 'u1', close: 'turn' }],
        cursors: { default: null },
        prompts: 1,
      },
    ],
  ]),
};

// §11.2: a watched Explore subagent as the `$.state` family `subagents` kept it: its task and one row.
const SUB_SEED: StateSeed = {
  state: { isOn: true, source: '/watchdog on' },
  values: new Map<string, unknown>([
    [
      `subagents:${SUB}`,
      {
        type: 'Explore',
        task: 'Find where the auth token is parsed.',
        watchdogs: ['default'],
        feed: {
          rows: [
            row(`${SUB}:task`, '**task** (subagent Explore):\nFind where the auth token is parsed.'),
            row('s1', '**agent**:\nSearching for the token parser.'),
          ],
          ends: [],
          cursors: { default: null },
          prompts: 0,
        },
        isRunning: true,
      },
    ],
  ]),
};

// The kit has nothing beneath the plugins for `session.append`: the call rejects after the hooks saw the row.
const append = async ($: Engine, input: SessionAppendInput): Promise<void> => {
  await $.session.append(input).catch(() => undefined);
};

// One main turn whose end is a boundary.
const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
  await $.turn.complete(turnEnd(`t${n}`));
};

const note = async ($: Engine, agentId: string): Promise<ToolCallResult> =>
  $.tool.call({ tool: 'mcp__watchdog__note', agentId, note: 'parseDate drops the timezone', severity: 'concern' });

const status = async ($: Engine): Promise<string[]> => ((await $.command.run(typed('status'))).text ?? '').split('\n');

// The review prompts the mod spawned.
const reviews = (seen: { spawns: readonly { prompt: string; subagentType: string }[] }): string[] =>
  seen.spawns.filter((spawn) => spawn.subagentType.startsWith('watchdog:')).map((spawn) => spawn.prompt);

const records = (writes: readonly unknown[]): unknown[] => {
  const last = writes.at(-1);
  return Array.isArray(last) ? last : [];
};

describe('§14.6 a reload', () => {
  test('rebuilds the id set, the stop map, the review that runs with the time left of its timer, and the log', async ($, on: Stubs) => {
    const seen = stubDelivery(on);
    const state = stubState(on, SEED);
    await $.session.start(START);

    expect(await status($)).toContain('default reviewing');
    expect(await note($, OLD_AGENT)).toEqual({ result: DROPPED });
    expect(await note($, REVIEW_AGENT)).toEqual({ result: QUEUED });
    await seen.clock.advance(999);
    expect(seen.taskStops).toEqual([]);
    await seen.clock.advance(1);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(records(state.logWrites)).toEqual([
      OLD_RECORD,
      { kind: 'timeout', watchdog: 'default', agentId: REVIEW_AGENT, time: NOW + 1000 },
    ]);
  });

  test('keeps the feed: the batch of a review that timed out with no note comes back in the next review', async ($, on: Stubs) => {
    const seen = stubDelivery(on);
    stubState(on, SEED);
    await $.session.start(START);
    await mainTurn($, 2);
    expect(reviews(seen)).toEqual([]);

    await seen.clock.advance(1000);
    await mainTurn($, 3);
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toMatch(/Task 1\.[\s\S]*Task 2\.[\s\S]*Task 3\./u);
  });

  test('watches again each subagent of the session that the `subagents` family kept', async ($, on: Stubs) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    stubState(on, SUB_SEED);
    on('agent.list', () => ({
      value: [{ id: SUB, description: 'explore auth', type: 'Explore', status: 'running' as const }],
    }));
    await $.session.start(START);
    await append($, { ...mainRow('s2', 'assistant', 'Found it in auth/token.ts.'), agentId: SUB });
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });

    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toMatch(/Find where the auth token is parsed\.[\s\S]*Searching for the token parser\./u);
    expect(reviews(seen)[0]).toMatch(/Found it in auth\/token\.ts\./u);
  });
});
