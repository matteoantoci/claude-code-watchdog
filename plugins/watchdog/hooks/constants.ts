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

// §10.4: the nudges of concerns alone for each person prompt.
export const NUDGE_BUDGET = 1;

// §10.4: the nudges that carry a blocker for each person prompt; the concerns of such a nudge take none of the above.
export const BLOCKER_NUDGE_BUDGET = 2;

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

// §7.8: a review that runs this long after its spawn times out.
export const REVIEW_TIMEOUT_MS = 600_000;

// §13.3, §15: a cost shows in dollars and cents; a cost above 0 and below a cent shows `<$0.01`.
export const USD_DIGITS = 2;
export const USD_CENT = 0.01;

// §13.4: the dump shows a review's cost to 1/100 cent.
export const DUMP_USD_DIGITS = 4;

// §13.3: token counts show as `12.8k` from a thousand and as `1.3M` from a million.
export const TOKENS_K = 1000;
export const TOKENS_M = 1_000_000;

// §13.3: below this many columns the status table narrows to `name state $`.
export const STATUS_NARROW_COLUMNS = 80;

// §13.3: the width of each status column but `file`, which takes the rest of the row (prototype variant A).
export const STATUS_NAME_WIDTH = 12;
export const STATUS_MODEL_WIDTH = 26;
export const STATUS_STATE_WIDTH = 11;
export const STATUS_REVIEWS_WIDTH = 9;
export const STATUS_NOTES_WIDTH = 10;
export const STATUS_TOKENS_WIDTH = 8;
export const STATUS_COST_WIDTH = 10;

// §13.3: the reason and the failure parts of a watchdog indent this many columns under its row.
export const STATUS_DETAIL_INDENT = 2;

// §13.3: the status snapshots that wait for their `CommandOutput` render or stay for a redraw, oldest out.
export const STATUS_SNAPSHOT_CAP = 20;

// §13.1, §13: the hotkeys of the full cards, top to bottom: letters, never a digit, as a bare digit in an empty
// composer presses a band Button (d.ts 9071-9073). The band shows one card for each, then `+N more`.
export const BAND_CARD_HOTKEYS = ['a', 'b', 'c'] as const;

export const BAND_CARD_LIMIT = BAND_CARD_HOTKEYS.length;

// §13.1, §12.5: below this many `bodyColumns`, one line for each note and the short failure line.
export const BAND_LINE_COLUMNS = 80;

// §13.1: below this many `bodyColumns`, the note text is cut.
export const BAND_TINY_COLUMNS = 50;

// §13.1: the longest note text of the cut form.
export const BAND_TINY_TEXT_MAX = 40;

// §13.1: the body of an expanded card indents this many columns under its header.
export const BAND_CARD_INDENT = 2;

// §13.1: the fewest blank cells between the count line's title and the focus hint; with less room, the hint goes.
export const BAND_HINT_GAP = 2;

// §12.5: the halt's next try shows in whole minutes.
export const MINUTE_MS = 60_000;

// §14.4: `$.session.messages()` gives the newest 4096 messages; at this length the list slides as it grows.
export const MESSAGES_READ_CAP = 4096;

// §14.4, §10.8: the rewind mark and the note id hash with 32-bit FNV-1a: its offset basis and its prime.
export const FNV_OFFSET_BASIS = 2_166_136_261;
export const FNV_PRIME = 16_777_619;

// §10.8: an open note's id is its hash in this many digits of this base.
export const NOTE_ID_DIGITS = 4;
export const NOTE_ID_RADIX = 36;

// §14.2: the `$.store` prune keeps the keys of this many sessions, the newest by `lastUsed`.
export const STORE_SESSION_CAP = 50;
