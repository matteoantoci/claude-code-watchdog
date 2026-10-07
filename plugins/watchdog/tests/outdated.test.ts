import { describe, expect, test } from 'claude-code/testing';
import { bandTarget, stubEngineBand } from './fixtures/band';
import { PERSON_PROMPT, REVIEW_SPAWN, nudgeTurnText, stubDelivery } from './fixtures/delivery';
import { stateIn, stubState } from './fixtures/on-state';
import { SESSION_ID, START, USAGE, mainRow, reviewAgentId, turnEnd, typed } from './fixtures/session';
import type { Band } from '../hooks/band/cards';
import type { LogRecord } from '../hooks/log/log';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents, DeliverySeen } from './fixtures/delivery';
import type { OnStateSeen } from './fixtures/on-state';
import type { SessionAppendInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<DeliveryEvents | 'state.get' | 'state.set' | 'ui.render'>;

const CART = '/repo/cart.py';
const BLOCKER = 'cart.py is reported as done, but line 3 still subtracts the percent as an amount.';
const OTHER = 'util.py has no test for round_price.';

// The engine's `agent.spawn` of review `n`: each review gets its own agent (§7.5), so a review's note calls are its own.
const toolUse = (n: number): string => `toolu_plugin_0000000000000000000000000000000${n}`;

const learnReview = async ($: Engine, n: number): Promise<string> => {
  await $.agent.spawn({ ...REVIEW_SPAWN, tool_use_id: toolUse(n) });
  return reviewAgentId(toolUse(n));
};

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

// The primary agent's `Edit` call on `path`, as one response row.
const editRow = (uuid: string, path: string): SessionAppendInput => ({
  ...mainRow(uuid, 'assistant', ''),
  message: {
    type: 'assistant',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: `toolu_${uuid}`,
        name: 'Edit',
        input: { file_path: path, old_string: 'a', new_string: 'b' },
      },
    ],
  },
});

// One person turn: its prompt and its rows, in order; the test ends it.
const personTurn = async ($: Engine, turnId: string, rows: readonly SessionAppendInput[]): Promise<void> => {
  await $.prompt.submit(PERSON_PROMPT);
  await $.turn.start({ text: PERSON_PROMPT.text, turnId });
  await rows.reduce(async (done, row) => {
    await done;
    await append($, row);
  }, Promise.resolve());
};

// The note tool call of a review agent.
const note = async ($: Engine, agentId: string, sent: { severity: string; text: string }): Promise<void> => {
  await $.tool.call({ tool: 'mcp__watchdog__note', agentId, note: sent.text, severity: sent.severity });
};

const THE_BLOCKER = { severity: 'blocker', text: BLOCKER };

const reviewEnd = async ($: Engine, agentId: string): Promise<void> => {
  await $.turn.complete({ ...turnEnd(`end-${agentId}`), agentId, usage: USAGE });
};

const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

const cards = (state: OnStateSeen): Band['cards'] =>
  (stateIn(state, SESSION_ID, 'band') as Band | undefined)?.cards ?? [];

const setUp = (on: Stubs): { seen: DeliverySeen; state: OnStateSeen } => {
  const seen = stubDelivery(on, { isReviewIdPerSpawn: true });
  const state = stubState(on);
  stubEngineBand(on);
  return { seen, state };
};

// Review 1 takes turn 1 (its batch ends at `a1`, turn 1). Turn 2 edits cart.py; review 1, still on its old batch,
// sends a blocker on cart.py and a concern on util.py while turn 2 runs, then turn 2 ends: both notes are late.
const theRace = async ($: Engine): Promise<string> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await personTurn($, 't1', [mainRow('u1', 'user', 'Add cart_total.'), mainRow('a1', 'assistant', 'Done.')]);
  await $.turn.complete(turnEnd('t1'));
  const first = await learnReview($, 1);
  await personTurn($, 't2', [mainRow('u2', 'user', 'Check line 3.'), editRow('e1', CART)]);
  await note($, first, THE_BLOCKER);
  await note($, first, { severity: 'concern', text: OTHER });
  await $.turn.complete(turnEnd('t2'));
  return first;
};

describe('§10.8 the outdated mark', () => {
  test('a note after an edit on the file it names is marked, not dropped; a note on another file has no mark', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    await theRace($);

    expect(seen.logs.slice(-2)).toEqual([
      `[blocker] default: ${BLOCKER} (steered)`,
      `[concern] default: ${OTHER} (steered)`,
    ]);
    expect(cards(state).map(({ text, turn, edits }) => ({ text, turn, edits }))).toEqual([
      { text: BLOCKER, turn: 1, edits: 1 },
      { text: OTHER, turn: 1, edits: 0 },
    ]);
    const ui = await $.ui.mount(bandTarget('terminal', { bodyColumns: 200 }));
    expect((await ui.find({ key: 'watchdog-card-0' }))?.text).toBe(
      `▸ BLOCKER  default · may be outdated: 1 edit since · cart.py is reported as done, but line 3 still subtracts the percent as an amount. · 1 turn ago · nudge pending`
    );
    expect((await ui.find({ key: 'watchdog-card-1' }))?.text).toBe(
      `▸ CONCERN  default · ${OTHER} · 1 turn ago · nudge pending`
    );
    await ui.unmount();

    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).toContain(
      `<note severity="blocker" turns_ago="1" outdated="1 edit since its review">${BLOCKER}</note>`
    );
    expect(nudges(seen)[0]).toContain(`<note severity="concern" turns_ago="1">${OTHER}</note>`);
  });
});

describe('§10.8 a later review of the same watchdog', () => {
  test('a later review that covers the edit and sends no repeat supersedes the held note: list, card, one row, dump', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    const first = await theRace($);
    await reviewEnd($, first);
    const second = await learnReview($, 2);
    expect(cards(state).map((card) => card.text)).toEqual([BLOCKER, OTHER]);
    const rows = seen.logs.length;

    await reviewEnd($, second);
    expect(seen.logs.slice(rows)).toEqual([`[blocker] default: ${BLOCKER} (dropped:superseded)`]);
    expect(cards(state).map((card) => card.text)).toEqual([OTHER]);
    const records = state.logWrites.at(-1) as readonly LogRecord[];
    const sent = records.find((record) => record.kind === 'review' && record.agentId === first);
    expect(sent?.kind === 'review' ? sent.notes : []).toEqual([
      { severity: 'blocker', text: BLOCKER, delivery: 'dropped:superseded' },
      { severity: 'concern', text: OTHER, delivery: 'steered' },
    ]);

    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).not.toContain(BLOCKER);
    expect(nudges(seen)[0]).toContain(OTHER);
  });

  test('a later review that sends the note again keeps it, with that review batch: the mark goes', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    const first = await theRace($);
    await reviewEnd($, first);
    const second = await learnReview($, 2);
    await note($, second, THE_BLOCKER);
    await reviewEnd($, second);

    expect(seen.logs.some((row) => row.includes('superseded'))).toBe(false);
    expect(cards(state).map(({ text, turn, edits }) => ({ text, turn, edits }))).toEqual([
      { text: BLOCKER, turn: 2, edits: 0 },
      { text: OTHER, turn: 1, edits: 0 },
    ]);
    await seen.clock.advance(2000);
    expect(nudges(seen)[0]).toContain(`<note severity="blocker">${BLOCKER}</note>`);
  });

  test('a delivered note keeps its row; a later silent review that covers the edit removes only its card', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await personTurn($, 't1', [mainRow('u1', 'user', 'Add cart_total.'), mainRow('a1', 'assistant', 'Done.')]);
    await $.turn.complete(turnEnd('t1'));
    const first = await learnReview($, 1);
    await personTurn($, 't2', [mainRow('u2', 'user', 'Add a test.'), mainRow('a2', 'assistant', 'Added.')]);
    await $.turn.complete(turnEnd('t2'));

    // §10.3: the late note waits for its nudge: the row, the card and the next review's recap say `nudge pending`.
    await note($, first, THE_BLOCKER);
    expect(seen.logs.at(-1)).toBe(`[blocker] default: ${BLOCKER} (nudge pending)`);
    await reviewEnd($, first);
    expect(seen.spawns.at(-1)?.prompt).toContain(`- [blocker] ${BLOCKER} (nudge pending)`);
    const second = await learnReview($, 2);
    expect(cards(state).map((card) => card.delivery)).toEqual(['nudge pending']);

    // The nudge goes out: the card and the recap of a later review say `nudged`.
    await seen.clock.advance(2000);
    await $.turn.start({ text: nudgeTurnText(nudges(seen).at(-1) ?? ''), turnId: 't3' });
    expect(cards(state).map((card) => card.delivery)).toEqual(['nudged']);
    await append($, editRow('e1', CART));
    await $.tool.call({ tool: 'Edit', file_path: CART, old_string: 'a', new_string: 'b' });
    expect(cards(state).map((card) => card.edits)).toEqual([1]);
    await $.turn.complete(turnEnd('t3'));
    await reviewEnd($, second);
    expect(seen.spawns.at(-1)?.prompt).toContain(`- [blocker] ${BLOCKER} (nudged)`);
    const third = await learnReview($, 3);
    expect(cards(state)).toHaveLength(1);

    const rows = seen.logs.length;
    await reviewEnd($, third);
    expect(cards(state)).toEqual([]);
    expect(seen.logs.slice(rows)).toEqual([]);
  });
});
