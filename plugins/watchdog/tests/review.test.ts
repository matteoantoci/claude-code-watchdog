import { describe, expect, test } from 'claude-code/testing';
import { LOG_NOTICE_ROW } from './fixtures/engine/log-notice';
import { noticeRow, withText } from './fixtures/recorded';
import { REVIEW_AGENT, SESSION_ID, START, USAGE, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { SessionStubs } from './fixtures/session';
import type { AgentSpawnInput, ApiMessage, SessionAppendInput, TurnStepInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The kit's `session.append` rejects on 2.1.290 and accepts on 2.1.293: catch it, after the hooks saw the row.
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
    expect(seen.spawns[0]?.prompt).toBe(
      '### Session update\n\n**user**:\nFix the date parser.\n\n**agent**:\nI will edit parse.ts.'
    );
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

  test("the engine's notice echo of the mod's own log row stays out of the next review (l3-self-review-log-rows)", async ($, on: SessionStubs) => {
    const seen = stubSession(on);
    await startOn($);
    await append($, mainRow('u1', 'user', 'First task.'));
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn(SPAWN);
    await $.tool.call({ tool: 'mcp__watchdog__note', agentId: REVIEW_AGENT, note: 'Check null.', severity: 'concern' });
    await $.turn.complete(reviewEnd);
    expect(seen.logs).toEqual(['[concern] default: Check null. (nudge pending)']);
    // The engine's echo of that row, and another plugin's log row, in the recorded notice shape.
    await append($, noticeRow('n1', seen.logs[0] ?? ''));
    await append($, withText(LOG_NOTICE_ROW, 'n2', 'linter: 0 problems'));
    await append($, mainRow('u2', 'user', 'Second task.'));
    await $.turn.complete(turnEnd('t2'));

    const prompt = seen.spawns.at(-1)?.prompt ?? '';
    expect(prompt).toContain('Second task.');
    expect(prompt).toContain('[notice informational] linter: 0 problems');
    expect(prompt).not.toContain('watchdog: [concern] default: Check null.');
  });
});

const callRow = (id: string, name: string, input: unknown): SessionAppendInput => ({
  ...mainRow(`row-${id}`, 'assistant', ''),
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const resultRow = (id: string, tool: string, text: string): SessionAppendInput => ({
  uuid: `result-${id}`,
  door: 'tool-result',
  origin: { kind: 'tool', tool },
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

const BASH_INPUT = { command: 'npm test', description: 'Run the tests' };

// The main conversation in Messages API form, as `$.session.messages({ as: 'api' })` gives it after turn t3.
const API_VIEW: readonly ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the date parser.' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/parse.ts' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const parse = 1;' }] },
  { role: 'user', content: [{ type: 'text', text: 'Add a test.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Adding one.' }] },
  {
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>\nToday is Tuesday.\n</system-reminder>' },
      { type: 'text', text: 'Now run it.' },
    ],
  },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: BASH_INPUT }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: '1 passed' }] },
];

// The watchdog's note history of this session in `$.store` (§14.2).
const STORED_NOTES = new Map([
  [
    `notes:${SESSION_ID}`,
    {
      watchdogs: {
        default: {
          keys: [{ key: 'check the null date', severity: 'concern' }],
          notes: [{ text: 'Check the null date.', severity: 'concern', delivery: 'steered' }],
        },
      },
      lastUsed: 1,
    },
  ],
]);

describe('the spawn prompt of a merged review', () => {
  test('the next review gets every waiting update in the omp form, with its markers and the recap', async ($, on: SessionStubs) => {
    const seen = stubSession(on, {
      messages: API_VIEW,
      store: STORED_NOTES,
      serverToolUses: [
        { id: 'srvtoolu_1', name: 'advisor', input: { question: 'Is one test enough?' }, startedAt: 1, endedAt: 2 },
      ],
    });
    await startOn($);
    await append($, mainRow('u1', 'user', 'Fix the date parser.'));
    await append($, callRow('toolu_1', 'Read', { file_path: '/repo/parse.ts' }));
    await append($, resultRow('toolu_1', 'Read', 'export const parse = 1;'));
    await $.turn.complete(turnEnd('t1'));
    // The engine's spawn of the first review; the stub counts it too.
    await $.agent.spawn(SPAWN);
    const spawnsAfterFirst = seen.spawns.length;

    await append($, mainRow('u2', 'user', 'Add a test.'));
    await append($, mainRow('a2', 'assistant', 'Adding one.'));
    await $.turn.complete(turnEnd('t2'));
    await append($, mainRow('u3', 'user', 'Now run it.'));
    await append($, callRow('toolu_3', 'Bash', BASH_INPUT));
    await step($, { ...mainStep(0), turnId: 't3' });
    await append($, resultRow('toolu_3', 'Bash', '1 passed'));
    await step($, { ...mainStep(1), turnId: 't3' });
    expect(seen.spawns.length).toBe(spawnsAfterFirst);

    await $.turn.complete(reviewEnd);
    expect(seen.spawns.length).toBe(spawnsAfterFirst + 1);
    expect(seen.spawns.at(-1)?.prompt).toBe(
      [
        '### Your notes so far (newest first)',
        '',
        '- [concern] Check the null date. (steered)',
        '',
        "### The person's prompts since the watchdog started (newest first)",
        '',
        '**user**:\nNow run it.',
        '',
        '**user**:\nAdd a test.',
        '',
        '**user**:\nFix the date parser.',
        '',
        '### Earlier updates (newest first, one line for each tool call)',
        '',
        '→ Read(/repo/parse.ts) ⇒ ok · 1 line',
        '',
        '### Session update',
        '',
        '**user**:\nAdd a test.',
        '',
        '**agent**:\nAdding one.',
        '',
        '**user**:\nNow run it.',
        '',
        '**agent**:',
        '→ Bash({"command":"npm test","description":"Run the tests"}) ⇒ ok · 1 line',
        'Tool result:\n```text\n1 passed\n```',
        '',
        '→ advisor(Is one test enough?)\n⇒ advisor: done',
        '',
        '---',
        '',
        '[in progress — more steps follow]',
      ].join('\n')
    );
  });
});
