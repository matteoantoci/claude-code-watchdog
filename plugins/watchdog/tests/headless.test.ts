import { describe, expect, test } from 'claude-code/testing';
import { badValueWarning, envSwitch, settingsEnvWarning } from '../hooks/lifecycle/headless';
import { dropBacklog, isUnboundReject, waitingUpdates } from '../hooks/review/backlog';
import { REVIEW_SPAWN, sendNote, stubDelivery, wrapped } from './fixtures/delivery';
import { stubOnState } from './fixtures/on-state';
import {
  HEADLESS_START,
  HOME,
  REVIEW_AGENT,
  SESSION_ID,
  START,
  USAGE,
  mainRow,
  stubSession,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents } from './fixtures/delivery';
import type { OnStateStubs } from './fixtures/on-state';
import type { SessionEvents } from './fixtures/session';
import type { SessionAppendInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The end of a `-p` run: the engine's end step and the dump file it leaves.
type EndEvents = 'session.end' | 'fs.write';

type Stubs = OnEvents<SessionEvents | EndEvents>;

type DeliveryEndStubs = OnEvents<DeliveryEvents | EndEvents>;

type Written = { path: string; text: string }[];

const stubEnd = (on: OnEvents<EndEvents>): Written => {
  const written: Written = [];
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  return written;
};

const ENV_ON = { HOME, CLAUDE_WATCHDOG: 'on' };

const ON_STATUS = 'watchdog on · nudge 0/1 · cooldown 0\non source: CLAUDE_WATCHDOG\ndefault idle';

const END = { reason: 'other', sessionId: SESSION_ID, resume: { id: SESSION_ID } } as const;

// The engine's prompt of a `-p` or SDK run: a person prompt (§10).
const SDK_PROMPT = { text: 'Fix the parser.', wait: false, origin: { kind: 'sdk' } } as const;

const CONCERN = 'parseDate drops the timezone';

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

// One main turn with a prompt row and an answer row; its `turn.complete` closes one update.
const mainTurn = async ($: Engine, turnId: string): Promise<void> => {
  await append($, mainRow(`u-${turnId}`, 'user', `Prompt of ${turnId}.`));
  await append($, mainRow(`a-${turnId}`, 'assistant', `Answer of ${turnId}.`));
  await $.turn.complete(turnEnd(turnId));
};

const status = async ($: Engine): Promise<string> => (await $.command.run(typed('status'))).text ?? '';

// A headless run on CLAUDE_WATCHDOG: an sdk turn t1 that ended, then a late concern of the review.
const lateConcern = async ($: Engine): Promise<void> => {
  await $.session.start(HEADLESS_START);
  await $.agent.spawn(REVIEW_SPAWN);
  await $.prompt.submit(SDK_PROMPT);
  await $.turn.start({ text: SDK_PROMPT.text, turnId: 't1' });
  await $.turn.complete(turnEnd('t1'));
  await sendNote($, 'concern', CONCERN);
};

describe('the CLAUDE_WATCHDOG switch', () => {
  const none = { project: {}, local: {} };

  test('on and 1 turn on; unset and empty do nothing; each other value keeps off with a warning', () => {
    expect(envSwitch('on', none)).toEqual({ isOn: true });
    expect(envSwitch('1', none)).toEqual({ isOn: true });
    expect(envSwitch(undefined, none)).toEqual({ isOn: false });
    expect(envSwitch('', none)).toEqual({ isOn: false });
    expect(envSwitch('ON', none)).toEqual({ isOn: false, warning: badValueWarning('ON') });
  });

  test('a project or local env value of it keeps the session off, whatever the value', () => {
    const set = { env: { CLAUDE_WATCHDOG: 'on' } };
    expect(envSwitch('on', { ...none, project: set })).toEqual({ isOn: false, warning: settingsEnvWarning('project') });
    expect(envSwitch('yes', { ...none, local: set })).toEqual({ isOn: false, warning: settingsEnvWarning('local') });
    expect(envSwitch('on', { ...none, project: { env: { OTHER: '1' } } })).toEqual({ isOn: true });
  });
});

describe('the -p backlog', () => {
  const rows = ['r1', 'r2', 'r3'].map((uuid) => ({ uuid, text: uuid }));
  const feed = { rows, ends: ['r1', 'r3'], cursors: { default: null } };

  test('the updates after a cursor or a batch end', () => {
    expect(waitingUpdates(feed, null)).toBe(2);
    expect(waitingUpdates(feed, 'r1')).toBe(1);
    expect(waitingUpdates(feed, 'r3')).toBe(0);
  });

  test('a dropped backlog leaves no update', () => {
    const dropped = dropBacklog(feed, 'default');
    expect(dropped.cursors).toEqual({ default: 'r3' });
    expect(waitingUpdates(dropped, dropped.cursors['default'])).toBe(0);
  });

  test('only the unbound reject drops the backlog', () => {
    expect(isUnboundReject('no session is bound')).toBe(true);
    expect(isUnboundReject('rate limited')).toBe(false);
  });
});

describe('CLAUDE_WATCHDOG at session.start', () => {
  test('a headless session with CLAUDE_WATCHDOG=on turns on at once and unsets the variable', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
    expect(seen.agents.map((agent) => agent.name)).toEqual(['default']);
    expect(seen.preflights).toHaveLength(1);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
  });

  test('1 turns a headless session on too', async ($, on: Stubs) => {
    stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: '1' } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });

  test('an interactive session unsets CLAUDE_WATCHDOG and ignores it', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    await $.session.start(START);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    expect(seen.settingsReads).toEqual([]);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
  });

  test('an unset or empty variable does nothing and leaves no dump', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: '' } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    await $.session.end(END);
    expect(seen.settingsReads).toEqual([]);
    expect(written).toEqual([]);
  });

  test('another value leaves a headless session off with one dump warning', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: { HOME, CLAUDE_WATCHDOG: 'yes' } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    await $.session.end(END);
    expect(written.map((write) => write.path)).toEqual([
      `${HOME}/.claude/watchdog/dumps/${SESSION_ID}-20261006-090503.md`,
    ]);
    expect(written[0]?.text).toContain(`- warning: ${badValueWarning('yes')}`);
  });

  test('the project and local settings are the sources read; their env value keeps the session off', async ($, on: Stubs) => {
    const env = { CLAUDE_WATCHDOG: 'on' };
    const seen = stubSession(on, { env: ENV_ON, settings: { local: { env } } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(seen.settingsReads).toEqual(['project', 'local']);
    expect(await status($)).toBe('watchdog off');
    expect(seen.agents).toEqual([]);
    expect(seen.envSets).toEqual([['CLAUDE_WATCHDOG', undefined]]);
    await $.session.end(END);
    expect(written[0]?.text).toContain(`- warning: ${settingsEnvWarning('local')}`);
  });

  test('a project env value keeps it off, also when the user settings set it too', async ($, on: Stubs) => {
    const env = { CLAUDE_WATCHDOG: 'on' };
    stubSession(on, { env: ENV_ON, settings: { project: { env }, user: { env } } });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe('watchdog off');
    await $.session.end(END);
    expect(written[0]?.text).toContain(`- warning: ${settingsEnvWarning('project')}`);
  });

  test('user settings and the shell can turn it on', async ($, on: Stubs) => {
    stubSession(on, { env: ENV_ON, settings: { user: { env: { CLAUDE_WATCHDOG: 'on' } } } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });

  test('a reload keeps the on state though the variable is gone', async ($, on: OnStateStubs) => {
    stubSession(on);
    stubOnState(on, { state: { isOn: true, source: 'CLAUDE_WATCHDOG' } });
    await $.session.start(HEADLESS_START);
    expect(await status($)).toBe(ON_STATUS);
  });
});

describe('delivery in -p', () => {
  test('a late concern sends no nudge and waits as an aside for the next sdk prompt', async ($, on: DeliveryEndStubs) => {
    const seen = stubDelivery(on, { env: ENV_ON });
    await lateConcern($);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (aside on next prompt)`);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
    await seen.clock.advance(2000);
    expect(seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>'))).toEqual([]);
    await $.prompt.submit(SDK_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });

  test('session.end writes the dump file with the note that still waits', async ($, on: DeliveryEndStubs) => {
    stubDelivery(on, { env: ENV_ON });
    const written = stubEnd(on);
    await lateConcern($);
    await $.session.end(END);
    expect(written.map((write) => write.path)).toEqual([
      `${HOME}/.claude/watchdog/dumps/${SESSION_ID}-20261006-090503.md`,
    ]);
    expect(written[0]?.text).toContain(`- waiting: [concern] default: ${CONCERN} (aside on next prompt)`);
  });

  test('a steer with no tool result before the turn ended waits as an aside', async ($, on: DeliveryEndStubs) => {
    const seen = stubDelivery(on, { env: ENV_ON });
    await $.session.start(HEADLESS_START);
    await $.agent.spawn(REVIEW_SPAWN);
    await $.prompt.submit(SDK_PROMPT);
    await $.turn.start({ text: SDK_PROMPT.text, turnId: 't1' });
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (steered)`);
    await $.turn.complete(turnEnd('t1'));
    await seen.clock.advance(2000);
    expect(seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>'))).toEqual([]);
    await $.prompt.submit(SDK_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });
});

describe('backlog at the end of -p', () => {
  test('a no session is bound spawn reject drops the backlog with an unreviewed record', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON, spawnDeny: 'no session is bound' });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    expect(seen.spawns).toHaveLength(2);
    expect(await status($)).toBe(ON_STATUS);
    await $.session.end(END);
    const text = written[0]?.text ?? '';
    // One record for each reject, each with the update since the last; session.end finds no backlog left.
    expect(text.match(/unreviewed: \d+ updates/gu)).toEqual(['unreviewed: 1 updates', 'unreviewed: 1 updates']);
    expect(text).toContain('### 2026-10-06T09:05:03Z · default · unreviewed: 1 updates');
  });

  test('session.end records each backlog that no review took', async ($, on: Stubs) => {
    const seen = stubSession(on, { env: ENV_ON });
    const written = stubEnd(on);
    await $.session.start(HEADLESS_START);
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    await mainTurn($, 't3');
    expect(seen.spawns).toHaveLength(1);
    await $.session.end(END);
    expect(written[0]?.text).toContain('### 2026-10-06T09:05:03Z · default · unreviewed: 2 updates');
  });

  test('an interactive session writes no dump file at its end', async ($, on: Stubs) => {
    stubSession(on);
    const written = stubEnd(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 't1');
    await mainTurn($, 't2');
    await $.session.end(END);
    expect(written).toEqual([]);
  });
});
