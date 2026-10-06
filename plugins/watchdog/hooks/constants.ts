// Every fixed number and limit of the mod (spec §4.7). The section that uses a value names it.

// §5.1: the lowest Claude Code release the mod runs on.
export const MIN_CLAUDE_CODE_VERSION = '2.1.290';

// §4.2: `maxNotesPerReview` when no file sets it.
export const DEFAULT_MAX_NOTES_PER_REVIEW = 4;

// §6.1: the most turns one review agent takes.
export const MAX_TURNS = 12;

// §5.2: the preflight asks each distinct model for one token.
export const PREFLIGHT_MAX_TOKENS = 1;

// §4.2: `maxNotesPerReview` is an integer from 1 to this value.
export const MAX_NOTES_PER_REVIEW = 32;

// §4.2: the most characters of a watchdog slug.
export const SLUG_MAX_LENGTH = 64;

// §14.2: the guard keys of one watchdog in `notes:<sessionId>`, oldest out first.
export const NOTE_KEY_CAP = 200;

// §7.7, §14.2: the newest notes of one watchdog that `notes:<sessionId>` keeps in full for the recap.
export const RECAP_NOTE_CAP = 20;

// §7.6: a tool result keeps this many chars, half from its head and half from its tail.
export const TOOL_RESULT_CAP = 4000;

// §7.6: a tool input keeps this many chars.
export const TOOL_INPUT_CAP = 8000;

// §7.6: a `thinking` text keeps this many chars.
export const THINKING_CAP = 8000;

// §7.6: one review batch; a larger batch collapses its older updates to one line for each tool call.
export const BATCH_CAP = 120_000;

// §7.7 part 2: the person's prompts, newest first.
export const RECAP_PROMPTS_CAP = 20_000;

// §7.7 part 3: the older updates, one line for each tool call, newest first.
export const RECAP_UPDATES_CAP = 30_000;

// §7.6: omp's one-line summary of a tool argument or a row (`PRIMARY_ARG_MAX`, session-history-format.ts:81).
export const ONE_LINE_MAX = 120;

// §7.6: omp's shortest code fence (`fencedText`, session-history-format.ts:201).
export const MIN_FENCE_LENGTH = 3;

// §13.4: the review log keeps the newest records.
export const LOG_RECORD_CAP = 100;

// §13.4: module memory keeps the full prompts of the newest reviews for `/watchdog dump raw`.
export const RAW_PROMPT_CAP = 5;

// §13.2: a `$.ui.log` row from a `command.run` hook waits, so that it lands below the command echo.
export const COMMAND_LOG_DELAY_MS = 300;

// §6.5, §14.1: the read-scope allow set keeps the newest 500 calls.
export const ALLOW_SET_CAP = 500;

// §10.3: a late note waits this long after a `turn.complete` before the nudge goes out.
export const NUDGE_WAIT_MS = 2000;

// §10.4: the nudges for each person prompt.
export const NUDGE_BUDGET = 1;

// §4.1: the nudge cooldown in main turns when `immuneTurns` is absent or bad, and its top.
export const DEFAULT_IMMUNE_TURNS = 3;
export const MAX_IMMUNE_TURNS = 5;

// §12.3 item 2: failed reviews in a row that halt a watchdog.
export const MAX_FAILED_REVIEWS = 3;

// §12.3 item 2: the halt waits before a try at a person prompt: 5 min, then 15 min, then 60 min each time.
const HALT_FIRST_WAIT_MS = 300_000;
const HALT_SECOND_WAIT_MS = 900_000;
const HALT_LATER_WAIT_MS = 3_600_000;
export const HALT_WAITS_MS: readonly number[] = [HALT_FIRST_WAIT_MS, HALT_SECOND_WAIT_MS, HALT_LATER_WAIT_MS];
