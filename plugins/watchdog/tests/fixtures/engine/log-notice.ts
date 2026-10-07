// The engine's echo of a `$.ui.log` row of the mod into the main conversation (spec §7.3 item 3, §13.2). Recorded
// by the live probe on 2.1.290: run verify-fixes, scenario tui-review (check l3-self-review-log-rows). Source: the
// observer records `ui.log` and the `session.append` that followed it in logs/observer-*.jsonl. The observer
// does not log `name`: the transcript files the row as subtype `informational`, and the mod drew the row as
// `[notice informational]` in a review prompt of run full-1, scenario tui-review. Scrubbed: the row uuid.
import type { SessionAppendInput } from 'claude-code';

// The text the mod passed to `$.ui.log`.
export const LOGGED_TEXT =
  '[concern] probe: WDPROBE math.js: add(a, b) returns a - b, so add(2, 3) returns -1, not 5 (nudged)';

// The row the engine appended for it: a notice led by the plugin's name.
export const LOG_NOTICE_ROW = {
  uuid: 'e0000000-0000-4000-8000-000000000001',
  door: 'notice',
  origin: { kind: 'engine' },
  message: {
    type: 'system',
    name: 'informational',
    content: [
      {
        type: 'text',
        text: 'watchdog: [concern] probe: WDPROBE math.js: add(a, b) returns a - b, so add(2, 3) returns -1, not 5 (nudged)',
      },
    ],
  },
} satisfies SessionAppendInput;
