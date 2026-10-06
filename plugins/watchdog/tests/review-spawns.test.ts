import { describe, expect, test } from 'claude-code/testing';
import {
  REVIEW_AGENT,
  START,
  USAGE,
  mainRow,
  reviewAgentId,
  stubAfterAtOnce,
  stubSession,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents } from './fixtures/session';
import type { AgentSpawnInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// `$.clock.after` runs at once, but the 10 min review timer (§7.8) never starts, so no review times out.
type Stubs = OnEvents<SessionEvents | 'clock.after'>;

const PROJECT_FILE = '/repo/WATCHDOG.json';

// The engine's `agent.spawn` of a review of watchdog `slug`, as the Agent tool fires it: the mod learns the id
// and the model from `next(e)` (§16.2).
const spawnOf = (slug: string, toolUseId: string): AgentSpawnInput => ({
  tool_use_id: toolUseId,
  prompt: 'review',
  description: `watchdog ${slug} review`,
  subagentType: `watchdog:${slug}`,
  provider: { plugin: 'watchdog', tier: 'user' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
});

const TOOL_USE_A = 'toolu_plugin_00000000000000000000000000000001';
const TOOL_USE_B = 'toolu_plugin_00000000000000000000000000000002';

// `/watchdog on`, then one main turn whose end closes an update for every watchdog (§7.4).
const firstUpdate = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.session.append(mainRow('u1', 'user', 'Fix the date parser.')).catch(() => undefined);
  await $.turn.complete(turnEnd('t1'));
};

// The watchdog lines of the status, one for each watchdog.
const watchdogLines = async ($: Engine): Promise<string[]> =>
  ((await $.command.run(typed('status'))).text ?? '').split('\n').filter((line) => line.endsWith('./WATCHDOG.json'));

describe('the roster model of a review spawn (§12.2, §16.2)', () => {
  test('a sonnet watchdog from a project WATCHDOG.json reviews on its model and its review ends idle', async ($, on: Stubs) => {
    stubAfterAtOnce(on);
    const roster = { watchdogs: [{ name: 'a', model: 'sonnet' }] };
    const seen = stubSession(on, { files: { [PROJECT_FILE]: { text: JSON.stringify(roster), mtimeMs: 1 } } });
    await firstUpdate($);
    expect(seen.spawns.map((spawn) => spawn.subagentType)).toEqual(['watchdog:a']);

    await $.agent.spawn(spawnOf('a', TOOL_USE_A));
    expect(await watchdogLines($)).toEqual(['a reviewing · ./WATCHDOG.json']);
    // No `usage`: the outcome compares the roster model with the model of the spawn's `next(e)` result.
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT });
    expect(await watchdogLines($)).toEqual(['a idle · ./WATCHDOG.json']);
  });
});

describe('two reviews at once (§7.5)', () => {
  test('each watchdog reviews with its own agent; a note goes to its own watchdog, an end frees only its own slot', async ($, on: Stubs) => {
    stubAfterAtOnce(on);
    const seen = stubSession(on, {
      files: { [PROJECT_FILE]: { text: JSON.stringify({ watchdogs: [{ name: 'a' }, { name: 'b' }] }), mtimeMs: 1 } },
      isReviewIdPerSpawn: true,
    });
    await firstUpdate($);
    expect(seen.spawns.map((spawn) => spawn.subagentType)).toEqual(['watchdog:a', 'watchdog:b']);

    await $.agent.spawn(spawnOf('a', TOOL_USE_A));
    await $.agent.spawn(spawnOf('b', TOOL_USE_B));
    const [agentA, agentB] = [reviewAgentId(TOOL_USE_A), reviewAgentId(TOOL_USE_B)];
    expect(await watchdogLines($)).toEqual(['a reviewing · ./WATCHDOG.json', 'b reviewing · ./WATCHDOG.json']);

    await $.tool.call({
      tool: 'mcp__watchdog__note',
      agentId: agentB,
      note: 'The lexer drops tabs.',
      severity: 'concern',
    });
    expect(seen.logs.at(-1)).toBe('[concern] b: The lexer drops tabs. (nudged)');
    await $.tool.call({
      tool: 'mcp__watchdog__note',
      agentId: agentA,
      note: 'parseDate drops the zone.',
      severity: 'nit',
    });
    expect(seen.logs.at(-1)).toBe('[nit] a: parseDate drops the zone. (aside on next prompt)');

    await $.turn.complete({ ...turnEnd('rb'), agentId: agentB, usage: USAGE });
    expect(await watchdogLines($)).toEqual(['a reviewing · ./WATCHDOG.json', 'b idle · ./WATCHDOG.json']);
    await $.turn.complete({ ...turnEnd('ra'), agentId: agentA, usage: USAGE });
    expect(await watchdogLines($)).toEqual(['a idle · ./WATCHDOG.json', 'b idle · ./WATCHDOG.json']);
  });
});
