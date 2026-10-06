import { describe, expect, test } from 'claude-code/testing';
import { NOW, REVIEW_AGENT, START, stubSession, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput, PluginState } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = SessionStubs & OnEvents<'turn.start' | 'state.set'>;

const NOTE = 'mcp__watchdog__note';
const GUIDANCE_PATH = '/prompts/boundary-guidance.md';

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

// The test's `$` has no `state` noun: a `state.set` hook beneath keeps each value the mod writes.
type Written = { log: PluginState['watchdog']['log']; turns?: number };

const stubSteer = (on: Stubs) => {
  const seen = stubSession(on);
  const written: Written = { log: [] };
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('state.set', (_$, e, next) => {
    if (e.key === 'log') {
      written.log = e.value;
    }
    if (e.key === 'turns') {
      written.turns = e.value;
    }
    return next(e);
  });
  return { seen, written };
};

const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.agent.spawn(SPAWN);
};

const sendNote = async ($: Engine, severity: string): Promise<void> => {
  await $.tool.call({ tool: NOTE, agentId: REVIEW_AGENT, note: 'parseDate drops the timezone', severity });
};

const mainBash = async ($: Engine) => $.tool.call({ tool: 'Bash', command: 'npm test' });

describe('steer delivery', () => {
  test('a concern takes the steer route; the kit rejects the append, so the note stays undelivered and the review log gets one error', async ($, on: Stubs) => {
    const { seen, written } = stubSteer(on);
    await startReview($);
    await sendNote($, 'concern');
    expect(seen.logs.at(-1)).toBe('[concern] default: parseDate drops the timezone (steered)');

    const result = await mainBash($);
    expect(result).toEqual({ result: 'core' });
    expect(seen.reads.filter((path) => path.endsWith(GUIDANCE_PATH)).length).toBe(1);
    expect(written.log.length).toBe(1);
    expect(written.log[0]).toMatchObject({ kind: 'error', watchdog: 'default', time: NOW });
    expect(written.log[0]?.error).toContain('steer append failed');

    // Undelivered: the note left the steer route, so the next tool result appends nothing more.
    await mainBash($);
    expect(written.log.length).toBe(1);
  });

  test('a nit stays held and no tool result appends it', async ($, on: Stubs) => {
    const { seen, written } = stubSteer(on);
    await startReview($);
    await sendNote($, 'nit');
    expect(seen.logs.at(-1)).toBe('[nit] default: parseDate drops the timezone (held)');

    await mainBash($);
    expect(written.log).toEqual([]);
  });

  test("the mod's own synthetic Agent call and a subagent's tool call steer nothing", async ($, on: Stubs) => {
    const { written } = stubSteer(on);
    await startReview($);
    await sendNote($, 'blocker');

    await $.tool.call({
      tool: 'Agent',
      tool_use_id: 'toolu_plugin_00000000000000000000000000000002',
      description: 'watchdog default review',
      prompt: 'review',
      subagent_type: 'watchdog:default',
    });
    await $.tool.call({ tool: 'mcp__docs__lookup', agentId: 'asub0001', query: 'parseDate' });
    expect(written.log).toEqual([]);

    await mainBash($);
    expect(written.log.length).toBe(1);
  });

  test('the turns counter in $.state adds 1 at each main-loop turn.start', async ($, on: Stubs) => {
    const { written } = stubSteer(on);
    await $.session.start(START);
    await $.turn.start({ text: 'Fix the parser.', turnId: 't1' });
    await $.turn.start({ text: '', turnId: 't2' });

    expect(written.turns).toBe(2);
  });
});
