import { describe, expect, test } from 'claude-code/testing';
import { AGENT_TOOL_AGENT, REVIEW_AGENT, START, stubSession, typed } from './fixtures/session';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

const NOTE = 'mcp__watchdog__note';

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

const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.agent.spawn(SPAWN);
};

describe('the note tool', () => {
  test('a note of a review agent gets the admitted ack and writes one log row', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startReview($);
    const logsBefore = seen.logs.length;
    const answer = await $.tool.call({
      tool: NOTE,
      agentId: REVIEW_AGENT,
      note: 'missing null check',
      severity: 'concern',
    });

    expect(answer).toEqual({ result: 'Queued. Do not re-raise.' });
    expect(seen.logs.slice(logsBefore)).toEqual(['[concern] default: missing null check (held)']);
    expect(seen.coreToolCalls).toEqual([]);
  });

  test('the main loop and an unknown agent get the deny, and no row', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startReview($);
    const logsBefore = seen.logs.length;
    const main = await $.tool.call({ tool: NOTE, note: 'x', severity: 'nit' });
    const unknown = await $.tool.call({ tool: NOTE, agentId: 'afake9999', note: 'x', severity: 'nit' });

    expect(main).toEqual({ deny: 'Only watchdog agents can call this tool.' });
    expect(unknown).toEqual({ deny: 'Only watchdog agents can call this tool.' });
    expect(seen.logs.length).toBe(logsBefore);
    expect(seen.coreToolCalls).toEqual([]);
  });

  test('a note with a severity outside the schema gets a deny', async ($, on: SessionStubs) => {
    stubSession(on);
    await startReview($);
    const answer = await $.tool.call({ tool: NOTE, agentId: REVIEW_AGENT, note: 'x', severity: 'urgent' });
    expect(answer.deny).toMatch(/severity/u);
  });
});

describe('the watchdog id set', () => {
  test('the id in the result of the synthetic Agent call of a watchdog spawn is learned', async ($, on: SessionStubs) => {
    stubSession(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    const before = await $.tool.call({ tool: NOTE, agentId: AGENT_TOOL_AGENT, note: 'x', severity: 'nit' });
    await $.tool.call({
      tool: 'Agent',
      tool_use_id: 'toolu_plugin_00000000000000000000000000000002',
      subagent_type: 'watchdog:default',
      description: 'watchdog default review',
      prompt: 'review',
    });
    const after = await $.tool.call({ tool: NOTE, agentId: AGENT_TOOL_AGENT, note: 'x', severity: 'nit' });

    expect(before).toEqual({ deny: 'Only watchdog agents can call this tool.' });
    expect(after).toEqual({ result: 'Queued. Do not re-raise.' });
  });

  test('the id of an Agent call of the primary agent is not learned', async ($, on: SessionStubs) => {
    stubSession(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await $.tool.call({
      tool: 'Agent',
      tool_use_id: 'toolu_01Koq5WS2oCWoqTNpb6ZSpFe',
      subagent_type: 'Explore',
      description: 'explore auth',
      prompt: 'find the auth flow',
    });
    const note = await $.tool.call({ tool: NOTE, agentId: AGENT_TOOL_AGENT, note: 'x', severity: 'nit' });
    expect(note).toEqual({ deny: 'Only watchdog agents can call this tool.' });
  });
});
