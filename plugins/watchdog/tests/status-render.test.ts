import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_SPAWN } from './fixtures/delivery';
import {
  REVIEW_AGENT,
  START,
  mainRow,
  stubAfterAtOnce,
  stubSession,
  subagentId,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { SessionEvents } from './fixtures/session';
import type { RenderSurface } from 'claude-code';
import type { Engine, Mounted } from 'claude-code/testing';

type Stubs = OnEvents<SessionEvents | 'ui.render' | 'ui.copy' | 'session.surfaces' | 'fs.write' | 'clock.after'>;

// Opus 5.5 (the default watchdog's `opus`): 25k × $4 + 2.5k × $20 per million = $0.15; 27.5k tokens.
const OPUS_USAGE = {
  input_tokens: 25_000,
  output_tokens: 2_500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
};

type Rendered = { copies: { text: string; surface: string | undefined }[] };

// The engine's own row beneath the mod, and the `$` calls of `/watchdog dump`.
const stubRender = (on: Stubs): Rendered => {
  const rendered: Rendered = { copies: [] };
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine row' }));
  on('ui.copy', (_$, e) => {
    rendered.copies.push({ text: e.text, surface: e.surface });
    return { value: { isCopied: true } };
  });
  on('session.surfaces', () => ({ value: ['terminal'] }));
  on('fs.write', () => ({ value: undefined }));
  stubAfterAtOnce(on);
  return rendered;
};

// `/watchdog on`, one main turn and its whole review, which ends with `usage`; one nit (an aside, so no nudge waits).
const runReview = async ($: Engine, usage: typeof OPUS_USAGE): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.session.append(mainRow('u1', 'user', 'Fix the date parser.')).catch(() => undefined);
  await $.turn.complete(turnEnd('t1'));
  await $.agent.spawn(REVIEW_SPAWN);
  await $.tool.call({ tool: 'mcp__watchdog__note', agentId: REVIEW_AGENT, note: 'Check null.', severity: 'nit' });
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage });
};

// The output row of one run on one surface, `columns` wide: `requestId` names the row, so two mounts of
// one id are one row on two surfaces.
const mountOutput = async (
  $: Engine,
  row: { args: string; text: string | undefined; requestId?: string },
  view: { surface: RenderSurface; columns: number }
) =>
  $.ui.mount({
    plugin: 'watchdog',
    surface: view.surface,
    component: 'CommandOutput',
    props: { command: 'watchdog', args: row.args, text: row.text ?? '', isErrored: false },
    viewport: { columns: view.columns, rows: 40 },
    ...(row.requestId === undefined ? {} : { requestId: row.requestId }),
  });

// d.ts `CommandOutput` `text`: the engine draws the `text` a hook answered under its plugin's name, and under
// each plugin's name whose `command.run` hook the run passed (live probe l3-status-table:
// `wdprobe+watchdog: watchdog on · …`).
const shown = (reply: string | undefined, names = 'watchdog'): string => `${names}: ${reply ?? ''}`;

const TERMINAL = { surface: 'terminal', columns: 120 } as const;

const DESKTOP = { surface: 'desktop', columns: 120 } as const;

// The table of `runReview`'s session, while on.
const expectTable = async (ui: Mounted<RenderSurface, 'CommandOutput'>): Promise<void> => {
  expect((await ui.find({ type: 'Text', text: /^watchdog on/u }))?.text).toBe(
    'watchdog on · nudge 0/1 · cooldown 0 · 27.5k tok · $0.15'
  );
  expect(await ui.find({ text: 'engine row' })).toBeUndefined();
  expect((await ui.find({ key: 'row:default' }))?.text).toMatch(
    /^default\s*claude-opus-5-5\/medium\s*idle\s*1\s*0B 0C 1N\s*27\.5k\s*\$0\.15\s*write ~\/\.claude\/WATCHDOG\.json to add watchdogs$/u
  );
  expect((await ui.find({ key: 'session' }))?.text).toMatch(/^session\s*1\s*0B 0C 1N\s*27\.5k\s*\$0\.15$/u);
  expect(await ui.find({ type: 'Text', text: 'last error: none' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'on source: /watchdog on' })).toBeDefined();
};

describe('/watchdog status table through command.run (§13.3)', () => {
  test('the row of the reply draws the first line with totals, the watchdog row, the session row and last error', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    await runReview($, OPUS_USAGE);
    const reply = await $.command.run(typed('status'));
    expect(reply.text).toBe('watchdog on · nudge 0/1 · cooldown 0\non source: /watchdog on\ndefault idle');

    // One row, drawn on the terminal and on the desktop.
    const terminal = await mountOutput($, { args: 'status', text: shown(reply.text), requestId: 'row-1' }, TERMINAL);
    await expectTable(terminal);
    await terminal.unmount();
    await expectTable(await mountOutput($, { args: 'status', text: shown(reply.text), requestId: 'row-1' }, DESKTOP));
  });

  test('the row of the reply under another plugin name too draws the table', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    await runReview($, OPUS_USAGE);
    const reply = await $.command.run(typed('status'));
    await expectTable(await mountOutput($, { args: 'status', text: shown(reply.text, 'wdprobe+watchdog') }, TERMINAL));
  });

  test('a bare /watchdog draws the table too; below 80 columns a row is `name state $`', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    await runReview($, { ...OPUS_USAGE, model: 'claude-opus-4-5' });
    const reply = await $.command.run(typed(''));
    const ui = await mountOutput($, { args: '', text: shown(reply.text) }, { surface: 'terminal', columns: 79 });
    expect((await ui.find({ key: 'row:default' }))?.text).toBe('default idle $?');
    expect((await ui.find({ key: 'session' }))?.text).toBe('session $?');
    expect(await ui.find({ key: 'header' })).toBeUndefined();
  });

  test('the table is the snapshot of its run: a later review changes the next table, not a drawn one', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    const before = await $.command.run(typed('status'));
    const first = await mountOutput($, { args: 'status', text: shown(before.text), requestId: 'first' }, TERMINAL);
    expect((await first.find({ key: 'session' }))?.text).toMatch(/\$0\.00$/u);
    await $.session.append(mainRow('u1', 'user', 'Fix the date parser.')).catch(() => undefined);
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn(REVIEW_SPAWN);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: OPUS_USAGE });
    const after = await $.command.run(typed('status'));
    expect(after.text).toBe(before.text);
    const second = await mountOutput($, { args: 'status', text: shown(after.text) }, TERMINAL);
    expect((await second.find({ key: 'session' }))?.text).toMatch(/\$0\.15$/u);
    // A redraw of the first row (a scroll, a resize) draws its own snapshot again.
    await first.unmount();
    const redrawn = await mountOutput($, { args: 'status', text: shown(before.text), requestId: 'first' }, TERMINAL);
    expect((await redrawn.find({ key: 'session' }))?.text).toMatch(/\$0\.00$/u);
  });

  test('a problem state and its reason draw red under the row', async ($, on: Stubs) => {
    // A full model id: the preflight reject of an alias is left to the review-time compare (§12.2).
    const roster = JSON.stringify({ watchdogs: [{ name: 'pinned', model: 'claude-opus-4-5' }] });
    const files = { '/repo/WATCHDOG.json': { text: roster, mtimeMs: 1 } };
    stubSession(on, { preflightDeny: 'model claude-opus-4-5 is not in availableModels', files });
    stubRender(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    const reply = await $.command.run(typed('status'));
    const ui = await mountOutput($, { args: 'status', text: shown(reply.text) }, TERMINAL);
    const colors = async (text: string | RegExp) =>
      (await ui.findAll({ type: 'Text', text })).map((element) => element.props['color']);
    expect(await colors('no_model')).toContain('error');
    expect(await colors(/not in availableModels$/u)).toContain('error');
  });

  test('a status row of no known run (before a reload) is the engine row', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    await $.session.start(START);
    const ui = await mountOutput($, { args: 'status', text: shown('watchdog on · nudge 0/1 · cooldown 0') }, TERMINAL);
    expect(await ui.find({ text: 'engine row' })).toBeDefined();
  });
});

describe('a subagent review in the status table (§11.4, §13.3, §15)', () => {
  test('the subagent line follows the session row and the review cost reaches the watchdog and session totals', async ($, on: Stubs) => {
    const subagents = JSON.stringify({ subagents: { Explore: true } });
    stubSession(on, { files: { '/repo/WATCHDOG.json': { text: subagents, mtimeMs: 1 } } });
    stubRender(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    const toolUseId = 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001';
    const sub = subagentId(toolUseId);
    await $.agent.spawn({
      tool_use_id: toolUseId,
      prompt: 'Find where the auth token is parsed.',
      description: 'explore auth',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-4-5',
      background: true,
      fork: false,
    });
    const row = { ...mainRow('s1', 'assistant', 'Searching for the token parser.'), agentId: sub };
    await $.session.append(row).catch(() => undefined);
    await $.turn.complete({ ...turnEnd('s1'), agentId: sub });
    await $.agent.spawn(REVIEW_SPAWN);
    await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: OPUS_USAGE });
    const reply = await $.command.run(typed('status'));
    const ui = await mountOutput($, { args: 'status', text: shown(reply.text) }, TERMINAL);
    expect(await ui.find({ type: 'Text', text: 'subagents: Explore 1 review' })).toBeDefined();
    expect((await ui.find({ key: 'row:default' }))?.text).toMatch(
      /^default\s*claude-opus-5-5\/medium\s*idle\s*1\s*0B 0C 0N\s*27\.5k\s*\$0\.15/u
    );
    expect((await ui.find({ key: 'session' }))?.text).toMatch(/^session\s*1\s*0B 0C 0N\s*27\.5k\s*\$0\.15$/u);
  });
});

describe('/watchdog dump row (§13.4)', () => {
  test('the path shows with a copy button that copies the path on the surface it was pressed on', async ($, on: Stubs) => {
    stubSession(on);
    const rendered = stubRender(on);
    await $.session.start(START);
    const reply = await $.command.run(typed('dump'));
    expect(reply.text).toMatch(/^watchdog dump: \/home\/me\/\.claude\/watchdog\/dumps\/.+\.md$/u);
    const path = (reply.text ?? '').replace('watchdog dump: ', '');
    rendered.copies.length = 0;
    const ui = await mountOutput($, { args: 'dump', text: shown(reply.text, 'wdprobe+watchdog') }, DESKTOP);
    expect((await ui.find({ type: 'Button' }))?.text).toBe('copy path');
    await ui.press({ key: 'copy-path' });
    expect(rendered.copies).toEqual([{ text: path, surface: 'desktop' }]);
  });
});
