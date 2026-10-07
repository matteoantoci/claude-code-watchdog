// Stubs and helpers for an L2 test of the `/watchdog status` table and the `/watchdog dump` row (spec §13.3,
// §13.4): the engine's own `CommandOutput` row beneath the mod, a review that ends with usage, and a mount of
// the row as a surface draws it.
import { expect } from 'claude-code/testing';
import { REVIEW_SPAWN } from './delivery';
import { STATUS_OUTPUT } from './engine/status-output';
import { ALONE } from './recorded';
import { REVIEW_AGENT, START, mainRow, stubAfterAtOnce, turnEnd, typed } from './session';
import type { OnEvents } from '../../hooks/on';
import type { SessionEvents } from './session';
import type { RenderSurface } from 'claude-code';
import type { Engine, Mounted } from 'claude-code/testing';

export type RenderStubs = OnEvents<
  SessionEvents | 'ui.render' | 'ui.copy' | 'session.surfaces' | 'fs.write' | 'clock.after'
>;

// Opus 5.5 (the default watchdog's `opus`): 25k × $4 + 2.5k × $20 per million = $0.15; 27.5k tokens.
export const OPUS_USAGE = {
  input_tokens: 25_000,
  output_tokens: 2_500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
};

export type Rendered = { copies: { text: string; surface: string | undefined }[] };

// The engine's own row beneath the mod, and the `$` calls of `/watchdog dump`.
export const stubRender = (on: RenderStubs): Rendered => {
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
export const runReview = async ($: Engine, usage: typeof OPUS_USAGE): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
  await $.session.append(mainRow('u1', 'user', 'Fix the date parser.')).catch(() => undefined);
  await $.turn.complete(turnEnd('t1'));
  await $.agent.spawn(REVIEW_SPAWN);
  await $.tool.call({ tool: 'mcp__watchdog__note', agentId: REVIEW_AGENT, note: 'Check null.', severity: 'nit' });
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage });
};

// The output row of one run on one surface, `columns` wide: the recorded props with the run's args and text.
// `requestId` names the row, so two mounts of one id are one row on two surfaces.
export const mountOutput = async (
  $: Engine,
  row: { args: string; text: string | undefined; requestId?: string },
  view: { surface: RenderSurface; columns: number }
) =>
  $.ui.mount({
    plugin: 'watchdog',
    surface: view.surface,
    component: 'CommandOutput',
    props: { ...STATUS_OUTPUT, args: row.args, text: row.text ?? '' },
    viewport: { columns: view.columns, rows: 40 },
    ...(row.requestId === undefined ? {} : { requestId: row.requestId }),
  });

// The row text of a reply: the engine draws it after the plugin names, as recorded (./recorded `ALONE`, `BESIDE`).
export const shown = (reply: string | undefined, lead = ALONE): string => `${lead}${reply ?? ''}`;

export const TERMINAL = { surface: 'terminal', columns: 120 } as const;

export const DESKTOP = { surface: 'desktop', columns: 120 } as const;

// The table of `runReview`'s session, while on.
export const expectTable = async (ui: Mounted<RenderSurface, 'CommandOutput'>): Promise<void> => {
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
