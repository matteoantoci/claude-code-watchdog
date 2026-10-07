import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_SPAWN, sendNote, stubDelivery } from './fixtures/delivery';
import { stateIn, stubState } from './fixtures/on-state';
import { REVIEW_AGENT, SESSION_ID, START, USAGE, mainRow, turnEnd, typed } from './fixtures/session';
import { stubSwitch } from './fixtures/switch';
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { SwitchStubs } from './fixtures/switch';
import type { ApiMessage, SessionAppendInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = DeliveryStubs & StateStubs & SwitchStubs;

const NEW_ID = 'c0ffee00-0000-4000-8000-000000000002';
const THIRD_ID = 'c0ffee00-0000-4000-8000-000000000003';

// The kit has nothing beneath the plugins for `session.append`: the call rejects after the hooks saw the row.
const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await $.turn.start({ turnId: `t${n}`, text: `Task ${n}.` });
  await append($, mainRow(`u${n}`, 'user', `Task ${n}.`));
  await $.turn.complete(turnEnd(`t${n}`));
};

// `/watchdog on`, a main turn, and the review's id as the engine's `agent.spawn` gives it.
const startReview = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await mainTurn($, 1);
  await $.agent.spawn(REVIEW_SPAWN);
};

// The resumed session's conversation in Messages API form: an earlier turn, then the last person prompt, a
// Read, the watchdog's own steer and the answer.
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

// A `notes:<sessionId>` value with one note of the default watchdog (§14.2).
const history = (text: string) => ({
  watchdogs: {
    default: {
      keys: [
        {
          key: text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim(),
          severity: 'nit',
        },
      ],
      notes: [{ text, severity: 'nit', delivery: 'aside on next prompt' }],
    },
  },
  lastUsed: 1,
});

// The review prompts the mod spawned (the test's own `REVIEW_SPAWN` reaches the stub too).
const reviews = (seen: { spawns: readonly { prompt: string }[] }): string[] =>
  seen.spawns.map((spawn) => spawn.prompt).filter((prompt) => prompt !== REVIEW_SPAWN.prompt);

const status = async ($: Engine): Promise<string[]> => ((await $.command.run(typed('status'))).text ?? '').split('\n');

describe('§14.3 /clear, /resume, /branch', () => {
  test('/clear stops each review with reason session and counts no failure', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current });
    const state = stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await ids.switchTo('clear', NEW_ID);

    expect(ids.ends).toEqual([{ reason: 'clear', sessionId: SESSION_ID }]);
    expect(seen.taskStops).toEqual([REVIEW_AGENT]);
    expect(stateIn(state, SESSION_ID, 'reviews')).toEqual({
      running: [],
      stops: [{ agentId: REVIEW_AGENT, reason: 'session' }],
    });
    expect(await status($)).toContain('default idle');
  });

  test('the first hook after /clear writes the carried-over values into the new $.state; the backlog resets', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current });
    const state = stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await mainTurn($, 2);
    await ids.switchTo('clear', NEW_ID);

    const carried = ['on', 'ids', 'health', 'turns', 'reviews'].map((key) => stateIn(state, NEW_ID, key));
    expect(carried).toEqual(['on', 'ids', 'health', 'turns', 'reviews'].map((key) => stateIn(state, SESSION_ID, key)));
    expect(carried).toEqual([
      { isOn: true, source: '/watchdog on' },
      [{ agentId: REVIEW_AGENT, watchdog: 'default' }],
      { watchdogs: { default: { problem: null, failures: 0, refused: 0 } }, lastError: null },
      2,
      { running: [], stops: [{ agentId: REVIEW_AGENT, reason: 'session' }] },
    ]);
    expect(stateIn(state, NEW_ID, 'feed')).toEqual({
      rows: [],
      ends: [],
      cursors: { default: null },
      prompts: 0,
      edits: 0,
    });

    // The stopped review's batch and the update that waited went with the backlog.
    await mainTurn($, 3);
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).not.toMatch(/Task [12]\./u);
    expect(reviews(seen)[1]).toMatch(/Task 3\./u);
  });

  test('/clear carries a failure count and its last error over', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    stubDelivery(on, { sessionId: () => ids.current });
    const state = stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, reason: 'error', answer: '' });
    const health = stateIn(state, SESSION_ID, 'health');
    expect(health).toEqual({
      watchdogs: { default: { problem: null, failures: 1, refused: 0 } },
      lastError: 'default: the review failed with no error text',
    });
    await ids.switchTo('clear', NEW_ID);
    expect(stateIn(state, NEW_ID, 'health')).toEqual(health);
  });

  test('the review log, the cost ledger and the nudge clock of module memory go into the new $.state', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current });
    const state = stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await sendNote($, 'concern', 'parseDate drops the timezone');
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
    await seen.clock.advance(2000);
    await ids.switchTo('clear', NEW_ID);

    expect(stateIn(state, NEW_ID, 'log')).toEqual(stateIn(state, SESSION_ID, 'log'));
    expect(stateIn(state, NEW_ID, 'log')).toEqual([expect.objectContaining({ kind: 'review', agentId: REVIEW_AGENT })]);
    expect(stateIn(state, NEW_ID, 'ledger')).toEqual(stateIn(state, SESSION_ID, 'ledger'));
    expect(stateIn(state, NEW_ID, 'ledger')).toMatchObject({ session: { reviews: 1, tokens: 1280 } });
    expect(stateIn(state, NEW_ID, 'nudge')).toEqual({ nudges: 1, nudgeTurn: null, dueAt: null, notes: [] });
  });

  test('/branch copies the note history to the new id, guard keys too, and replays the last prompt to the end', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current, messages: CONVERSATION });
    stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await sendNote($, 'concern', 'parseDate drops the timezone');
    await ids.switchTo('branch', NEW_ID);

    expect(seen.store.get(`notes:${NEW_ID}`)).toEqual(seen.store.get(`notes:${SESSION_ID}`));
    await mainTurn($, 2);
    expect(reviews(seen)[1]).toMatch(/\[concern\] parseDate drops the timezone \(/u);
    expect(reviews(seen)[1]).toMatch(
      /### Session update\n\n\[earlier history, before the watchdog started\]\n\n\*\*user\*\*:\nTask B\.[\s\S]*Done B\.[\s\S]*Task 2\./u
    );
    expect(reviews(seen)[1]?.split('### Session update')[1]).not.toMatch(/Task A\./u);
  });

  test('/resume loads the resumed id history as it is and replays; /clear starts an empty one with no replay', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const store = new Map([[`notes:${NEW_ID}`, history('Name the helper parseDate.')]]);
    const seen = stubDelivery(on, { sessionId: () => ids.current, messages: CONVERSATION, store });
    stubState(on, { sessionId: () => ids.current });
    await startReview($);
    await sendNote($, 'concern', 'parseDate drops the timezone');
    await ids.switchTo('resume', NEW_ID);
    await mainTurn($, 2);
    expect(reviews(seen)[1]).toMatch(/\[nit\] Name the helper parseDate\. \(aside on next prompt\)/u);
    expect(reviews(seen)[1]).not.toMatch(/parseDate drops the timezone/u);
    expect(reviews(seen)[1]).toMatch(/\[earlier history, before the watchdog started\]\n\n\*\*user\*\*:\nTask B\./u);

    await ids.switchTo('clear', THIRD_ID);
    await mainTurn($, 3);
    expect(reviews(seen)[2]).not.toMatch(/Your notes so far|earlier history/u);
  });
});
