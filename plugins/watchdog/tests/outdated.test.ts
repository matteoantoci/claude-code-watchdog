import { describe, expect, test } from 'claude-code/testing';
import { cardKey } from '../hooks/band/cards';
import { normalizeNote } from '../hooks/note/guard';
import { noteId } from '../hooks/note/retract';
import { bandTarget, stubEngineBand } from './fixtures/band';
import { PERSON_PROMPT, REVIEW_SPAWN, nudgeTurnText, stubDelivery } from './fixtures/delivery';
import { stateIn, stubState } from './fixtures/on-state';
import { SESSION_ID, START, USAGE, mainRow, reviewAgentId, turnEnd, typed } from './fixtures/session';
import type { Band } from '../hooks/band/cards';
import type { Feed } from '../hooks/feed/feed';
import type { LogRecord } from '../hooks/log/log';
import type { NoteHistory } from '../hooks/note/history';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents, DeliverySeen } from './fixtures/delivery';
import type { OnStateSeen } from './fixtures/on-state';
import type { SessionAppendInput, ToolCallResult } from 'claude-code';
import type { Engine } from 'claude-code/testing';

type Stubs = OnEvents<DeliveryEvents | 'state.get' | 'state.set' | 'ui.render'>;

const CART = '/repo/cart.py';
// The live run's stale blocker named the function, not the file it edited.
const BLOCKER = 'apply_discount subtracts the percent as an amount, so a 10% discount turns the total negative.';
const OTHER = 'round_price has no test.';
const REASON = 'Turn 2 changed apply_discount to subtract total * percent / 100.';

// The engine's `agent.spawn` of review `n`: each review gets its own agent (§7.5), so a review's note calls are its own.
const toolUse = (n: number): string => `toolu_plugin_0000000000000000000000000000000${n}`;

const learnReview = async ($: Engine, n: number, slug = 'default'): Promise<string> => {
  await $.agent.spawn({
    ...REVIEW_SPAWN,
    tool_use_id: toolUse(n),
    description: `watchdog ${slug} review`,
    subagentType: `watchdog:${slug}`,
  });
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

// The `resolve` tool call of a review agent (none for the main loop).
const resolve = async (
  $: Engine,
  agentId: string | undefined,
  input: Record<string, string>
): Promise<ToolCallResult> =>
  $.tool.call({ tool: 'mcp__watchdog__resolve', ...(agentId === undefined ? {} : { agentId }), ...input });

const THE_BLOCKER = { severity: 'blocker', text: BLOCKER };

const reviewEnd = async ($: Engine, agentId: string): Promise<void> => {
  await $.turn.complete({ ...turnEnd(`end-${agentId}`), agentId, usage: USAGE });
};

const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

const cards = (state: OnStateSeen): Band['cards'] =>
  (stateIn(state, SESSION_ID, 'band') as Band | undefined)?.cards ?? [];

// §13.1: the text of the count line on the terminal.
const countLine = async ($: Engine): Promise<string | undefined> => {
  const ui = await $.ui.mount(bandTarget('terminal', { bodyColumns: 200 }));
  const text = (await ui.find({ key: 'watchdog-count' }))?.text;
  await ui.unmount();
  return text;
};

const setUp = (
  on: Stubs,
  options: Parameters<typeof stubDelivery>[1] = {}
): { seen: DeliverySeen; state: OnStateSeen } => {
  const seen = stubDelivery(on, { isReviewIdPerSpawn: true, ...options });
  const state = stubState(on);
  stubEngineBand(on);
  return { seen, state };
};

// Review 1 takes turn 1 (its batch ends at `a1`, turn 1). Turn 2 edits cart.py; review 1, still on its old batch,
// sends a blocker that names apply_discount (not the file) and a concern while turn 2 runs, then turn 2 ends: both
// notes are late.
const theRace = async ($: Engine): Promise<string> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await personTurn($, 't1', [mainRow('u1', 'user', 'Add cart_total.'), mainRow('a1', 'assistant', 'Done.')]);
  await $.turn.complete(turnEnd('t1'));
  const first = await learnReview($, 1);
  await personTurn($, 't2', [mainRow('u2', 'user', 'Check apply_discount.'), editRow('e1', CART)]);
  await note($, first, THE_BLOCKER);
  await note($, first, { severity: 'concern', text: OTHER });
  await $.turn.complete(turnEnd('t2'));
  return first;
};

describe('§10.8 the outdated mark', () => {
  test('each note after an edit is marked, whatever it names, and never dropped', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    await theRace($);

    expect(seen.logs.slice(-2)).toEqual([
      `[blocker] default: ${BLOCKER} (steered)`,
      `[concern] default: ${OTHER} (steered)`,
    ]);
    expect(cards(state).map(({ text, turn, edits }) => ({ text, turn, edits }))).toEqual([
      { text: BLOCKER, turn: 1, edits: 1 },
      { text: OTHER, turn: 1, edits: 1 },
    ]);
    const ui = await $.ui.mount(bandTarget('terminal', { bodyColumns: 200 }));
    expect((await ui.find({ key: 'watchdog-card-0' }))?.text).toBe(
      `▸ BLOCKER  default · may be outdated: 1 edit since · ${BLOCKER} · 1 turn ago · nudge pending`
    );
    expect((await ui.find({ key: 'watchdog-card-1' }))?.text).toBe(
      `▸ CONCERN  default · may be outdated: 1 edit since · ${OTHER} · 1 turn ago · nudge pending`
    );
    await ui.unmount();

    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).toContain(
      `<note severity="blocker" turns_ago="1" outdated="1 edit since its review">${BLOCKER}</note>`
    );
    expect(nudges(seen)[0]).toContain(
      `<note severity="concern" turns_ago="1" outdated="1 edit since its review">${OTHER}</note>`
    );
  });

  test('later reviews that stay silent drop nothing; the mark stays once the edit row left the feed', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    const first = await theRace($);
    await reviewEnd($, first);
    const second = await learnReview($, 2);
    const rows = seen.logs.length;
    await reviewEnd($, second);
    expect(seen.logs.slice(rows)).toEqual([]);
    expect(cards(state).map(({ text, edits }) => ({ text, edits }))).toEqual([
      { text: BLOCKER, edits: 1 },
      { text: OTHER, edits: 1 },
    ]);
    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).toContain(BLOCKER);
    expect(nudges(seen)[0]).toContain(OTHER);

    // The nudge turn's review moves the cursor past `e1`, so the edit row leaves the feed (§7.1); its count stays.
    await $.turn.start({ text: nudgeTurnText(nudges(seen)[0] ?? ''), turnId: 't3' });
    await append($, mainRow('a3', 'assistant', 'Checked apply_discount.'));
    await $.turn.complete(turnEnd('t3'));
    const third = await learnReview($, 3);
    await reviewEnd($, third);
    expect(seen.logs.slice(rows).filter((row) => row.includes('superseded'))).toEqual([]);
    expect((stateIn(state, SESSION_ID, 'feed') as Feed).rows.map((row) => row.uuid)).not.toContain('e1');
    expect(cards(state).map(({ text, delivery, edits }) => ({ text, delivery, edits }))).toEqual([
      { text: BLOCKER, delivery: 'nudged', edits: 1 },
      { text: OTHER, delivery: 'nudged', edits: 1 },
    ]);
  });
});

describe('§10.8 a retraction', () => {
  test('the recap lists each open note with its id and mark; a retraction drops the held note: list, card, row, dump', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    const first = await theRace($);
    await reviewEnd($, first);
    const blockerId = noteId(cardKey({ watchdog: 'default', text: BLOCKER }));
    expect(seen.spawns.at(-1)?.prompt).toContain(
      [
        `- [concern · open ${noteId(cardKey({ watchdog: 'default', text: OTHER }))} · may be outdated: 1 edit since] ${OTHER} (nudge pending)`,
        `- [blocker · open ${blockerId} · may be outdated: 1 edit since] ${BLOCKER} (nudge pending)`,
      ].join('\n')
    );
    const second = await learnReview($, 2);
    const rows = seen.logs.length;
    expect(await countLine($)).toMatch(/^watchdog · 1 blocker · 1 concern +ctrl\+x tab · a\/b$/u);

    expect(await resolve($, second, { id: blockerId, reason: REASON })).toEqual({ result: 'Retracted.' });
    expect(seen.logs.slice(rows)).toEqual([`[blocker] default: ${BLOCKER} (dropped:superseded)`]);
    expect(cards(state).map((card) => card.text)).toEqual([OTHER]);
    expect(await countLine($)).toMatch(/^watchdog · 1 concern +ctrl\+x tab · a$/u);
    const records = state.logWrites.at(-1) as readonly LogRecord[];
    const sent = records.find((record) => record.kind === 'review' && record.agentId === first);
    expect(sent?.kind === 'review' ? sent.notes : []).toEqual([
      { severity: 'blocker', text: BLOCKER, delivery: 'dropped:superseded', reason: REASON },
      { severity: 'concern', text: OTHER, delivery: 'steered' },
    ]);
    // §7.7, §9.6: the recap says `dropped:superseded`, and the key leaves the guard keys.
    const history = seen.store.get(`notes:${SESSION_ID}`) as NoteHistory;
    expect(history.watchdogs.default?.notes.map(({ text, delivery }) => ({ text, delivery }))).toEqual([
      { text: BLOCKER, delivery: 'dropped:superseded' },
      { text: OTHER, delivery: 'nudge pending' },
    ]);
    expect(history.watchdogs.default?.keys.map((entry) => entry.key)).toEqual([normalizeNote(OTHER)]);
    expect(await resolve($, second, { id: blockerId, reason: REASON })).toEqual({
      result: 'Refused: no open note has this id.',
    });

    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).not.toContain(BLOCKER);
    expect(nudges(seen)[0]).toContain(OTHER);
  });

  test('a delivered note on the band: the retraction removes its card and writes one row', async ($, on: Stubs) => {
    const { seen, state } = setUp(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await personTurn($, 't1', [mainRow('u1', 'user', 'Add cart_total.'), mainRow('a1', 'assistant', 'Done.')]);
    await $.turn.complete(turnEnd('t1'));
    const first = await learnReview($, 1);
    await personTurn($, 't2', [mainRow('u2', 'user', 'Add a test.'), mainRow('a2', 'assistant', 'Added.')]);
    await $.turn.complete(turnEnd('t2'));
    await note($, first, THE_BLOCKER);
    await reviewEnd($, first);
    const second = await learnReview($, 2);

    // The nudge sends the note; its card stays as `nudged` until the next person prompt.
    await seen.clock.advance(2000);
    await $.turn.start({ text: nudgeTurnText(nudges(seen).at(-1) ?? ''), turnId: 't3' });
    await append($, editRow('e1', CART));
    await $.tool.call({ tool: 'Edit', file_path: CART, old_string: 'a', new_string: 'b' });
    expect(cards(state).map(({ delivery, edits }) => ({ delivery, edits }))).toEqual([
      { delivery: 'nudged', edits: 1 },
    ]);
    await $.turn.complete(turnEnd('t3'));
    const rows = seen.logs.length;

    const id = noteId(cardKey({ watchdog: 'default', text: BLOCKER }));
    expect(await resolve($, second, { id, reason: REASON })).toEqual({ result: 'Retracted.' });
    expect(cards(state)).toEqual([]);
    expect(seen.logs.slice(rows)).toEqual([`[blocker] default: ${BLOCKER} (dropped:superseded)`]);
    await reviewEnd($, second);
    expect(seen.spawns.at(-1)?.prompt).toContain(`- [blocker] ${BLOCKER} (dropped:superseded)`);
  });

  test('an unknown id, another watchdog note, the main loop and bad arguments are refused; nothing drops', async ($, on: Stubs) => {
    const roster = { watchdogs: [{ name: 'a' }, { name: 'b' }] };
    const { seen, state } = setUp(on, {
      files: { '/repo/WATCHDOG.json': { text: JSON.stringify(roster), mtimeMs: 1 } },
    });
    await $.session.start(START);
    await $.command.run(typed('on'));
    await personTurn($, 't1', [mainRow('u1', 'user', 'Add cart_total.'), mainRow('a1', 'assistant', 'Done.')]);
    await $.turn.complete(turnEnd('t1'));
    const agentA = await learnReview($, 1, 'a');
    const agentB = await learnReview($, 2, 'b');
    await note($, agentB, THE_BLOCKER);
    const rows = seen.logs.length;
    const id = noteId(cardKey({ watchdog: 'b', text: BLOCKER }));

    expect(await resolve($, agentA, { id, reason: REASON })).toEqual({
      result: "Refused: this note is another watchdog's.",
    });
    expect(await resolve($, agentA, { id: 'zzzz', reason: REASON })).toEqual({
      result: 'Refused: no open note has this id.',
    });
    expect(await resolve($, undefined, { id, reason: REASON })).toEqual({
      deny: 'Only watchdog agents can call this tool.',
    });
    expect(await resolve($, agentB, { id })).toEqual({
      deny: 'A retraction needs the `id` of an open note and a `reason`.',
    });
    expect(seen.logs.slice(rows)).toEqual([]);
    expect(cards(state).map(({ watchdog, text }) => ({ watchdog, text }))).toEqual([{ watchdog: 'b', text: BLOCKER }]);
  });
});
