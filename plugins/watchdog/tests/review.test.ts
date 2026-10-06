import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_AGENT, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, TurnStepInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The kit has nothing beneath the plugins for `session.append`: the call rejects after the hooks saw the row.
const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const step = async ($: Engine, e: TurnStepInput): Promise<void> => {
  const stream = $.turn.step(e);
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  await stream.result;
};

const mainStep = (index: number): TurnStepInput => ({ turnId: 't1', index, model: 'claude-opus-4-5', messageCount: 2 });

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

const agentRow = (uuid: string, text: string): SessionAppendInput => ({
  ...mainRow(uuid, 'assistant', text),
  agentId: REVIEW_AGENT,
});

const reviewEnd = { ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE } as const;

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

describe('review trigger', () => {
  test('a main turn.complete spawns one review whose prompt holds the rows of the turn', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await append($, mainRow('u1', 'user', 'Fix the date parser.'));
    await append($, mainRow('a1', 'assistant', 'I will edit parse.ts.'));
    await $.turn.complete(turnEnd('t1'));

    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.subagentType).toBe('watchdog:default');
    expect(seen.spawns[0]?.description).toBe('watchdog default review');
    expect(seen.spawns[0]?.prompt).toContain('user: Fix the date parser.');
    expect(seen.spawns[0]?.prompt).toContain('assistant: I will edit parse.ts.');
  });

  test('turn.step index 0 is no boundary; index 1 closes the update before its own step', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await append($, mainRow('u1', 'user', 'Rename the module.'));
    await step($, mainStep(0));
    expect(seen.spawns.length).toBe(0);

    await append($, mainRow('a1', 'assistant', 'Reading the module first.'));
    await step($, mainStep(1));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('Rename the module.');
    expect(seen.spawns[0]?.prompt).toContain('Reading the module first.');
  });

  test('nothing spawns while off, and no row before /watchdog on is replayed', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await $.session.start(START);
    await append($, mainRow('u0', 'user', 'Before on.'));
    await $.turn.complete(turnEnd('t0'));
    expect(seen.spawns.length).toBe(0);

    await $.command.run(typed('on'));
    await append($, mainRow('u1', 'user', 'After on.'));
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('After on.');
    expect(seen.spawns[0]?.prompt).not.toContain('Before on.');
  });

  test('/watchdog off stops feed recording and clears the backlog', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await append($, mainRow('u1', 'user', 'Waiting in the backlog.'));
    await $.command.run(typed('off'));
    await append($, mainRow('u2', 'user', 'Said while off.'));
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(0);

    await $.command.run(typed('on'));
    await append($, mainRow('u3', 'user', 'Said after on.'));
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('Said after on.');
    expect(seen.spawns[0]?.prompt).not.toContain('Waiting in the backlog.');
    expect(seen.spawns[0]?.prompt).not.toContain('Said while off.');
  });
});

describe('one review at a time, and no self-review', () => {
  test('a busy watchdog waits; its review end spawns the next review with the merged backlog', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await append($, mainRow('u1', 'user', 'First task.'));
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn(SPAWN);
    const spawnsAfterFirst = seen.spawns.length;

    await append($, mainRow('u2', 'user', 'Second task.'));
    await $.turn.complete(turnEnd('t2'));
    await append($, mainRow('u3', 'user', 'Third task.'));
    await step($, mainStep(1));
    expect(seen.spawns.length).toBe(spawnsAfterFirst);

    await $.turn.complete(reviewEnd);
    const next = seen.spawns.at(-1)?.prompt;
    expect(seen.spawns.length).toBe(spawnsAfterFirst + 1);
    expect(next).toContain('Second task.');
    expect(next).toContain('Third task.');
    expect(next).not.toContain('First task.');
  });

  test('fake watchdog agent events stay out of the feed and are no boundaries', async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await $.agent.spawn(SPAWN);
    const spawnsBefore = seen.spawns.length;

    await append($, mainRow('u1', 'user', 'First task.'));
    await append($, agentRow('w1', 'WATCHDOG READS parse.ts'));
    await step($, { ...mainStep(1), agentId: REVIEW_AGENT });
    await append($, {
      ...mainRow('s1', 'user', '<watchdog-notes>steer</watchdog-notes>'),
      door: 'note',
      origin: { kind: 'plugin', name: 'watchdog' },
    });
    await append($, {
      ...mainRow('h1', 'user', '<watchdog-notes>aside</watchdog-notes>'),
      door: 'hook-context',
      origin: { kind: 'plugin', event: 'prompt.submit' },
    });
    await append($, {
      ...mainRow('n1', 'user', `<task-notification>\n<task-id>${REVIEW_AGENT}</task-id>\n</task-notification>`),
      origin: { kind: 'task-notification' },
    });
    await $.turn.complete(reviewEnd);
    expect(seen.spawns.length).toBe(spawnsBefore);

    await $.turn.complete(turnEnd('t1'));
    const prompt = seen.spawns.at(-1)?.prompt ?? '';
    expect(seen.spawns.length).toBe(spawnsBefore + 1);
    expect(prompt).toContain('First task.');
    expect(prompt).not.toMatch(/WATCHDOG READS|watchdog-notes|task-notification/u);
  });
});
