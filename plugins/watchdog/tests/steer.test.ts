import { describe, expect, test } from 'claude-code/testing';
import { PERSON_PROMPT, nudgeTurnText, stubDelivery, wrapped } from './fixtures/delivery';
import { NOW, REVIEW_AGENT, START, stubSession, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents, DeliverySeen } from './fixtures/delivery';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput, PluginState } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = SessionStubs & OnEvents<'turn.start' | 'state.set'>;

type LateStubs = OnEvents<DeliveryEvents | 'state.set'>;

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

const keepWritten = (on: OnEvents<'state.set'>): Written => {
  const written: Written = { log: [] };
  on('state.set', (_$, e, next) => {
    if (e.key === 'log') {
      written.log = e.value;
    }
    if (e.key === 'turns') {
      written.turns = e.value;
    }
    return next(e);
  });
  return written;
};

const stubSteer = (on: Stubs) => {
  const seen = stubSession(on);
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  return { seen, written: keepWritten(on) };
};

// `/watchdog on`, the review agent's id, and a main turn that runs: a steer waits only inside a turn (§10.1).
const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.agent.spawn(SPAWN);
  await $.turn.start({ text: 'Fix the parser.', turnId: 't1' });
};

const sendNote = async ($: Engine, severity: string): Promise<void> => {
  await $.tool.call({ tool: NOTE, agentId: REVIEW_AGENT, note: 'parseDate drops the timezone', severity });
};

const mainBash = async ($: Engine) => $.tool.call({ tool: 'Bash', command: 'npm test' });

// The mod's nudges: the prompts it submitted, as the engine got them.
const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

// §10.1: the steer append of the note rejects in the kit; the review log gets one error for it, at `time`.
const expectOneSteerError = (written: Written, time = NOW): void => {
  const errors = written.log.filter((record) => record.kind === 'error');
  expect(errors.length).toBe(1);
  expect(errors[0]).toMatchObject({ kind: 'error', watchdog: 'default', time });
  const [record] = errors;
  expect(record?.kind === 'error' ? record.error : undefined).toContain('steer append failed');
};

const NOTE_ELEMENT = '<note severity="concern">parseDate drops the timezone</note>';

describe('steer delivery', () => {
  test('a concern takes the steer route; the kit rejects the append, so the note takes the late-note route and goes out as the nudge', async ($, on: LateStubs) => {
    const seen = stubDelivery(on);
    const written = keepWritten(on);
    await startReview($);
    await sendNote($, 'concern');
    expect(seen.logs.at(-1)).toBe('[concern] default: parseDate drops the timezone (steered)');

    await mainBash($);
    expect(seen.reads.filter((path) => path.endsWith(GUIDANCE_PATH)).length).toBe(1);
    expectOneSteerError(written);

    // Undelivered: the note left the steer route, so the next tool result appends nothing more.
    await mainBash($);
    expectOneSteerError(written);

    // §10.3: at the turn end the session is idle with the budget unspent: the late note is the nudge.
    await $.turn.complete(turnEnd('t1'));
    await seen.clock.advance(1999);
    expect(nudges(seen)).toEqual([]);
    await seen.clock.advance(1);
    expect(nudges(seen)).toEqual([wrapped(NOTE_ELEMENT)]);
    expectOneSteerError(written);
  });

  test('in the nudge turn the budget is spent: a steer whose append rejects waits as an aside on the next person prompt', async ($, on: LateStubs) => {
    const seen = stubDelivery(on);
    const written = keepWritten(on);
    await startReview($);
    // A blocker steered with no tool result is late at the turn end: it spends the one nudge.
    await $.tool.call({
      tool: NOTE,
      agentId: REVIEW_AGENT,
      note: 'The migration deletes the users table',
      severity: 'blocker',
    });
    await $.turn.complete(turnEnd('t1'));
    await seen.clock.advance(2000);
    expect(nudges(seen).length).toBe(1);

    await $.turn.start({ text: nudgeTurnText(nudges(seen).at(-1) ?? ''), turnId: 'n1' });
    await sendNote($, 'concern');
    expect(seen.logs.at(-1)).toBe('[concern] default: parseDate drops the timezone (steered)');
    await mainBash($);
    expectOneSteerError(written, NOW + 2000);

    await $.turn.complete(turnEnd('n1'));
    await seen.clock.advance(2000);
    expect(nudges(seen).length).toBe(1);
    await $.prompt.submit(PERSON_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(NOTE_ELEMENT)]);
  });

  test('a nit waits for the next person prompt and no tool result appends it', async ($, on: Stubs) => {
    const { seen, written } = stubSteer(on);
    await startReview($);
    await sendNote($, 'nit');
    expect(seen.logs.at(-1)).toBe('[nit] default: parseDate drops the timezone (aside on next prompt)');

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
