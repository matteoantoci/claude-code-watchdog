// The `CommandOutput` row of `/watchdog status` (spec §13.3): the engine draws the text that the mod's
// `command.run` hook answered after the names of the plugins whose hook the run passed. Recorded by the live
// probe on 2.1.290.
import type { RenderPropsOf } from 'claude-code';

// Run verify-fixes, scenario tui-review (check l3-status-table), with the probe's observer plugin `wdprobe`
// loaded beside the mod. Source: the observer records `command.run.out` and `ui.render.CommandOutput` in
// logs/observer-*.jsonl. The render's `requestId` is not a prop; the observer does not log `onScreen`.
export const STATUS_REPLY =
  'watchdog on · nudge 1/1 · cooldown 3\non source: /watchdog on\nprobe reviewing · ./WATCHDOG.json';

export const STATUS_OUTPUT = {
  command: 'watchdog',
  args: 'status',
  isErrored: false,
  text: 'wdprobe+watchdog: watchdog on · nudge 1/1 · cooldown 3\non source: /watchdog on\nprobe reviewing · ./WATCHDOG.json',
} satisfies RenderPropsOf['CommandOutput'];

// Run status-try, scenario noobs, with the mod alone. Source: the terminal screen in logs/tui-04-status.txt,
// where the engine drew its own row from the props text.
export const ALONE_REPLY =
  'watchdog on · nudge 0/1 · cooldown 0\non source: /watchdog on\nprobe idle · ./WATCHDOG.json';

export const ALONE_TEXT =
  'watchdog: watchdog on · nudge 0/1 · cooldown 0\non source: /watchdog on\nprobe idle · ./WATCHDOG.json';
