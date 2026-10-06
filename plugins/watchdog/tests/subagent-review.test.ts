import { describe, expect, test } from 'claude-code/testing';
import { readHistory, watchdogNotes } from '../hooks/note/history';
import { PERSON_PROMPT, REVIEW_SPAWN, sendNote, stubDelivery, wrapped } from './fixtures/delivery';
import {
  REVIEW_AGENT,
  SESSION_ID,
  START,
  USAGE,
  mainRow,
  stubSession,
  subagentId,
  turnEnd,
  typed,
} from './fixtures/session';
import type { LogRecord } from '../hooks/log/log';
import type { OnEvents } from '../hooks/on';
import type { DeliverySeen, DeliveryStubs } from './fixtures/delivery';
import type { Seen, SessionStubs, WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, TurnStepInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

const PROJECT_FILE = '/repo/WATCHDOG.json';

const file = (doc: unknown): WorkspaceFile => ({ text: JSON.stringify(doc), mtimeMs: 1 });

const EXPLORE_ON = { [PROJECT_FILE]: file({ subagents: { Explore: true } }) };

// The engine's `agent.spawn` of a subagent that the primary agent's `Agent` call starts.
const EXPLORE: AgentSpawnInput = {
  tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001',
  prompt: 'Find where the auth token is parsed.',
  description: 'explore auth',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

const SUB = subagentId(EXPLORE.tool_use_id);

// The engine teaches the id of the review the mod spawned; then the review ends.
const reviewEnd = async ($: Engine): Promise<void> => {
  await $.agent.spawn(REVIEW_SPAWN);
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
};

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const step = async ($: Engine, e: TurnStepInput): Promise<void> => {
  const stream = $.turn.step(e);
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  await stream.result;
};

// A row and a step of the subagent's loop.
const subRow = (uuid: string, role: 'user' | 'assistant', text: string): SessionAppendInput => ({
  ...mainRow(uuid, role, text),
  agentId: SUB,
});

const subStep = (index: number): TurnStepInput => ({
  turnId: 's1',
  index,
  model: 'claude-haiku-4-5',
  messageCount: 2,
  agentId: SUB,
});

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

// The prompts of the mod's review spawns, oldest first (not the engine's `agent.spawn` the test fires).
const reviews = (seen: Seen): string[] =>
  seen.spawns
    .filter((spawn) => spawn.subagentType.startsWith('watchdog:') && spawn.prompt !== REVIEW_SPAWN.prompt)
    .map((spawn) => spawn.prompt);

const IN_PROGRESS = '\n\n---\n\n[in progress — more steps follow]';

// A main turn that runs: the primary agent starts Explore, and the subagent's first step boundary spawns its
// review, whose id the engine teaches.
const startSubagentReview = async ($: Engine): Promise<void> => {
  await startOn($);
  await $.turn.start({ text: 'Fix the login bug.', turnId: 't1' });
  await $.agent.spawn(EXPLORE);
  await append($, subRow('s1', 'assistant', 'Searching for the token parser.'));
  await step($, subStep(1));
  await $.agent.spawn(REVIEW_SPAWN);
};

const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

const NIT = 'Name the helper parseBearer.';
const BLOCKER = 'The regex accepts expired tokens.';

// A loop the mod must not watch: its spawn, one row and its end.
const otherLoop = async ($: Engine, spawn: AgentSpawnInput): Promise<void> => {
  const agentId = subagentId(spawn.tool_use_id);
  await $.agent.spawn(spawn);
  await append($, { ...mainRow(`${agentId}-1`, 'assistant', 'Working on it.'), agentId });
  await $.turn.complete({ ...turnEnd('s1'), agentId });
};

type LogStubs = SessionStubs & OnEvents<'state.set'>;

describe('the subagent feed (§11.2)', () => {
  test('an opted-in subagent gets its own review: its task opens the first update, its rows stay out of the primary feed', async ($, on: SessionStubs) => {
    const seen = stubSession(on, { files: { [PROJECT_FILE]: file({ subagents: { Explore: true } }) } });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Fix the login bug.'));
    await $.agent.spawn(EXPLORE);
    await append($, subRow('s0', 'user', EXPLORE.prompt));
    await append($, subRow('s1', 'assistant', 'Searching for the token parser.'));
    await step($, subStep(0));
    expect(reviews(seen)).toEqual([]);

    await step($, subStep(1));
    expect(reviews(seen)).toEqual([
      `### Session update: subagent Explore\n\n**task** (subagent Explore):\n${EXPLORE.prompt}\n\n**agent**:\nSearching for the token parser.${IN_PROGRESS}`,
    ]);

    await $.turn.complete(turnEnd('t1'));
    expect(reviews(seen)).toHaveLength(1);
  });

  test('a teammate, a fork and a type the map does not name get no review', async ($, on: SessionStubs) => {
    const seen = stubSession(on, { files: EXPLORE_ON });
    await startOn($);
    await otherLoop($, { ...EXPLORE, tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0002', isTeammate: true });
    await otherLoop($, { ...EXPLORE, tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0003', fork: true });
    await otherLoop($, { ...EXPLORE, tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0004', subagentType: 'Plan' });
    expect(reviews(seen)).toEqual([]);
  });
});

describe('status and the review log (§11.1, §11.4)', () => {
  test('status counts the reviews of each opted-in type and warns about an unknown and a watchdog:* key; the log record labels the review', async ($, on: LogStubs) => {
    const subagents = { Explore: true, Explroe: true, 'watchdog:default': true };
    stubSession(on, { files: { [PROJECT_FILE]: file({ subagents }) } });
    const written: { log: readonly LogRecord[] } = { log: [] };
    on('state.set', (_$, e, next) => {
      if (e.key === 'log') {
        written.log = e.value;
      }
      return next(e);
    });
    await startOn($);
    await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in', provider: EXPLORE.provider });
    await $.agent.spawn(EXPLORE);
    await append($, subRow('s1', 'assistant', 'Searching for the token parser.'));
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    await reviewEnd($);

    const status = (await $.command.run(typed('status'))).text?.split('\n') ?? [];
    expect(status).toContain('subagents: Explore 1 review');
    expect(status).toContain('subagents: Explroe 0 reviews');
    expect(status).toContain('warning: subagents "watchdog:default": a watchdog type, ignored');
    expect(status).toContain('warning: subagents "Explroe": no agent.offer gave this type');
    expect(written.log.at(-1)).toMatchObject({
      kind: 'review',
      agentId: REVIEW_AGENT,
      subagent: { agentId: SUB, type: 'Explore' },
    });
  });
});

describe('one review at a time for each watchdog (§7.5, §11.2)', () => {
  test('a busy watchdog lets the subagent backlog wait; when free it takes the backlog whose update waits longest', async ($, on: SessionStubs) => {
    const seen = stubSession(on, { files: { [PROJECT_FILE]: file({ subagents: { Explore: ['default'] } }) } });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Fix the login bug.'));
    await $.turn.complete(turnEnd('t1'));
    expect(reviews(seen)).toEqual(['### Session update\n\n**user**:\nFix the login bug.']);

    await $.agent.spawn(EXPLORE);
    await append($, subRow('s1', 'assistant', 'Searching for the token parser.'));
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    await append($, mainRow('u2', 'user', 'Also check the logout path.'));
    await $.turn.complete(turnEnd('t2'));
    expect(reviews(seen)).toHaveLength(1);

    await reviewEnd($);
    expect(reviews(seen)[1]).toBe(
      `### Session update: subagent Explore\n\n**task** (subagent Explore):\n${EXPLORE.prompt}\n\n**agent**:\nSearching for the token parser.`
    );

    await reviewEnd($);
    expect(reviews(seen)[2]).toBe('### Session update\n\n**user**:\nAlso check the logout path.');
    await reviewEnd($);
    expect(reviews(seen)).toHaveLength(3);
  });
});

describe('delivery of the notes on a subagent (§11.3)', () => {
  test('while it runs every severity goes into its next tool result as context; the primary agent gets none', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    await startSubagentReview($);
    await sendNote($, 'nit', NIT);
    await sendNote($, 'blocker', BLOCKER);
    expect(seen.logs.slice(-2)).toEqual([
      `[nit · Explore] default: ${NIT} (steered)`,
      `[blocker · Explore] default: ${BLOCKER} (steered)`,
    ]);

    expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toEqual({ result: 'core' });
    const call = await $.tool.call({ tool: 'mcp__docs__lookup', agentId: SUB, query: 'parseToken' });
    expect(call).toEqual({
      result: 'core',
      context: [wrapped(`<note severity="nit">${NIT}</note>`, `<note severity="blocker">${BLOCKER}</note>`)],
    });
    expect(await $.tool.call({ tool: 'mcp__docs__lookup', agentId: SUB, query: 'expired' })).toEqual({
      result: 'core',
    });

    await $.turn.complete(turnEnd('t1'));
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    await seen.clock.advance(2000);
    await $.prompt.submit(PERSON_PROMPT);
    expect(nudges(seen)).toEqual([]);
    expect(seen.prompts.at(-1)?.context).toBeUndefined();
  });

  test('a note the subagent did not get is late at its end: it goes to the primary agent with the subagent label', async ($, on: DeliveryStubs &
    OnEvents<'state.set'>) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    const saved: { nudge: readonly unknown[] } = { nudge: [] };
    on('state.set', (_$, e, next) => {
      if (e.key === 'nudge') {
        saved.nudge = e.value.notes;
      }
      return next(e);
    });
    await startSubagentReview($);
    await $.turn.complete(turnEnd('t1'));
    await sendNote($, 'nit', NIT);
    await sendNote($, 'blocker', BLOCKER);

    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    expect(saved.nudge).toMatchObject([{ text: BLOCKER, subagent: { agentId: SUB, type: 'Explore' } }]);
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([wrapped(`<note severity="blocker" subagent="Explore">${BLOCKER}</note>`)]);
    await $.prompt.submit(PERSON_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="nit" subagent="Explore">${NIT}</note>`)]);
  });
});

describe('the note history of a subagent (§11.4)', () => {
  test('each subagent has its own key set; a late note on it is first checked against the primary agent set', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: EXPLORE_ON });
    const known = 'Check the expiry branch.';
    const repeated = 'Keep the old token format.';
    await startOn($);
    await append($, mainRow('u1', 'user', 'Fix the login bug.'));
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn(REVIEW_SPAWN);
    await sendNote($, 'concern', known);
    await sendNote($, 'concern', repeated);
    await $.agent.spawn(EXPLORE);
    await append($, subRow('s1', 'assistant', 'Searching for the token parser.'));
    await step($, subStep(1));
    await reviewEnd($);
    await $.agent.spawn(REVIEW_SPAWN);

    await sendNote($, 'concern', known);
    await sendNote($, 'concern', BLOCKER);
    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    expect(seen.logs.at(-1)).toBe(`[concern · Explore] default: ${known} (dropped:duplicate)`);
    const late = await $.tool.call({
      tool: 'mcp__watchdog__note',
      agentId: REVIEW_AGENT,
      note: repeated,
      severity: 'concern',
    });
    expect(late).toEqual({ result: 'Dropped: already raised.' });

    const keys = (key: string): string[] =>
      watchdogNotes(readHistory(seen.store.get(key)), 'default').keys.map((entry) => entry.key);
    expect(keys(`notes:${SESSION_ID}:${SUB}`)).toEqual(['check the expiry branch', 'the regex accepts expired tokens']);
    expect(keys(`notes:${SESSION_ID}`)).toEqual([
      'check the expiry branch',
      'keep the old token format',
      'the regex accepts expired tokens',
    ]);
  });
});
