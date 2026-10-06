// Every fixed number and limit of the mod (spec §4.7). The section that uses a value names it.

// §5.1: the lowest Claude Code release the mod runs on.
export const MIN_CLAUDE_CODE_VERSION = '2.1.290';

// §4.2: `maxNotesPerReview` when no file sets it.
export const DEFAULT_MAX_NOTES_PER_REVIEW = 4;

// §6.1: the most turns one review agent takes.
export const MAX_TURNS = 12;

// §5.2: the preflight asks each distinct model for one token.
export const PREFLIGHT_MAX_TOKENS = 1;

// §14.2: the guard keys of one watchdog in `notes:<sessionId>`, oldest out first.
export const NOTE_KEY_CAP = 200;

// §7.7, §14.2: the newest notes of one watchdog that `notes:<sessionId>` keeps in full for the recap.
export const RECAP_NOTE_CAP = 20;
