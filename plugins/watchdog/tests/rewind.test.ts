import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_SPAWN, sendNote, stubDelivery } from './fixtures/delivery';
import { stateIn, stubState } from './fixtures/on-state';
import { REVIEW_AGENT, SESSION_ID, START, mainRow, subagentId, turnEnd, typed } from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, SessionMessage } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = DeliveryStubs & StateStubs & OnEvents<'session.compact'>;

// The main conversation as `$.session.messages()` gives it; a test changes it as the person rewinds.
type Talk = { messages: SessionMessage[] };

const said = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] });

const turnOf = (n: number): SessionMessage[] => [said('user', `Task ${n}.`), said('assistant', `Done ${n}.`)];

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

// One main turn: its prompt row, a step boundary that carries `count` messages, its end.
const mainTurn = async ($: Engine, n: number, count: number): Promise<void> => {
  await $.turn.start({ turnId: `t${n}`, text: `Task ${n}.` });
  await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
  const stream = $.turn.step({ turnId: `t${n}`, index: 1, model: 'claude-opus-4-5', messageCount: count });
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  await stream.result;
  await $.turn.complete(turnEnd(`t${n}`));
};

// `/watchdog on`, turn 1, and the review's id as the engine's `agent.spawn` gives it.
const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await mainTurn($, 1, 1);
  await $.agent.spawn(REVIEW_SPAWN);
};

const reviews = (seen: { spawns: readonly { prompt: string }[] }): string[] =>
  seen.spawns.map((spawn) => spawn.prompt).filter((prompt) => prompt !== REVIEW_SPAWN.prompt);

describe('§14.4 /rewind', () => {
  test('a restore found at the next boundary stops each review with reason rewind; the next update starts with the marker', async ($, on: Stubs) => {
    const talk: Talk = { messages: turnOf(1) };
    const seen = stubDelivery(on, { transcript: () => talk.messages });
    const state = stubState(on);
    await startReview($);
    await sendNote($, 'concern', 'parseDate drops the timezone');

    // The person restores the conversation to before turn 1, then asks again.
    talk.messages = turnOf(2);
    await mainTurn($, 2, 1);

    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(state.reviewsWrites.at(-1)).toMatchObject({ stops: [{ agentId: REVIEW_AGENT, reason: 'rewind' }] });
    expect(reviews(seen)[1]).toMatch(
      /### Session update\n\n\[user rewound the conversation\]\n\n\*\*user\*\*:\nTask 2\./u
    );
    // §9.6: the guard keys go, the recap notes stay; the nudge of the note that waited went with it.
    expect(seen.store.get(`notes:${SESSION_ID}`)).toMatchObject({
      watchdogs: { default: { keys: [], notes: [{ text: 'parseDate drops the timezone' }] } },
    });
    expect(reviews(seen)[1]).toMatch(/\[concern\] parseDate drops the timezone/u);
    await seen.clock.advance(5000);
    expect(seen.prompts).toEqual([]);
  });

  test('a smaller step messageCount finds the rewind without the hash', async ($, on: Stubs) => {
    const talk: Talk = { messages: [] };
    const seen = stubDelivery(on, { transcript: () => talk.messages });
    stubState(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    talk.messages = turnOf(1);
    await mainTurn($, 1, 9);
    await $.agent.spawn(REVIEW_SPAWN);
    await mainTurn($, 2, 3);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
  });

  test('a conversation that only grew, or a compaction, is no rewind', async ($, on: Stubs) => {
    const talk: Talk = { messages: turnOf(1) };
    const seen = stubDelivery(on, { transcript: () => talk.messages });
    stubState(on);
    on('session.compact', (_$, e) => ({ messages: [...e.messages] }));
    await startReview($);
    talk.messages = [...turnOf(1), ...turnOf(2)];
    await mainTurn($, 2, 3);

    await $.session.compact({ trigger: 'manual', messages: talk.messages });
    talk.messages = [said('user', 'Summary.'), ...turnOf(3)];
    await mainTurn($, 3, 2);
    expect(seen.taskStops).toEqual([]);
  });

  test('a restore writes null for each watched subagent in the `subagents` family, so a reload does not watch it again', async ($, on: Stubs) => {
    const explore: AgentSpawnInput = {
      tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001',
      prompt: 'Find where the auth token is parsed.',
      description: 'explore auth',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-4-5',
      background: true,
      fork: false,
    };
    const files: Record<string, WorkspaceFile> = {
      '/repo/WATCHDOG.json': { text: JSON.stringify({ subagents: { Explore: true } }), mtimeMs: 1 },
    };
    const talk: Talk = { messages: turnOf(1) };
    stubDelivery(on, { transcript: () => talk.messages, files });
    const state = stubState(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 1, 1);
    await $.agent.spawn(explore);
    expect(stateIn(state, SESSION_ID, `subagents:${subagentId(explore.tool_use_id)}`)).toMatchObject({
      type: 'Explore',
    });

    talk.messages = turnOf(2);
    await mainTurn($, 2, 1);
    expect(stateIn(state, SESSION_ID, `subagents:${subagentId(explore.tool_use_id)}`)).toBeNull();
  });
});
