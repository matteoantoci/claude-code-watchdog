// Every fixed number and limit of the mod (spec §4.7). The section that uses a value names it.

// §5.1: the lowest Claude Code release the mod runs on.
export const MIN_CLAUDE_CODE_VERSION = '2.1.290';

// §4.2: `maxNotesPerReview` when no file sets it.
export const DEFAULT_MAX_NOTES_PER_REVIEW = 4;

// §6.1: the most turns one review agent takes.
export const MAX_TURNS = 12;

// §5.2: the preflight asks each distinct model for one token.
export const PREFLIGHT_MAX_TOKENS = 1;

// §13.4: the review log keeps the newest records.
export const LOG_RECORD_CAP = 100;

// §13.4: module memory keeps the full prompts of the newest reviews for `/watchdog dump raw`.
export const RAW_PROMPT_CAP = 5;

// §13.2: a `$.ui.log` row from a `command.run` hook waits, so that it lands below the command echo.
export const COMMAND_LOG_DELAY_MS = 300;
