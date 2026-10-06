import { DEFAULT_WATCHDOG } from '../agents/roster';
import { parseRosterFile, skippedFile } from './parse';
import { displayPath } from './paths';
import type { Roster, Watchdog } from '../agents/roster';
import type { ParsedEntry, ParsedFile, SubagentChoice } from './parse';
import type { Where } from './paths';

// One searched path as `$` read it: no `content` when the file is not there.
export type LoadedFile = {
  readonly path: string;
  readonly isUser: boolean;
  readonly content?: { readonly text: string } | { readonly error: string };
};

// §4.2: a later file replaces each `subagents` key it sets; `false` removes the key.
const mergeSubagents = (files: readonly ParsedFile[]): Record<string, true | readonly string[]> => {
  const last = Object.fromEntries(files.flatMap((file) => Object.entries<SubagentChoice>(file.subagents)));
  return Object.fromEntries(
    Object.entries(last).flatMap(([key, choice]) => (choice === false ? [] : [[key, choice] as const]))
  );
};

// §4.2: the union of the entries of all files, in load order; the same slug replaces the earlier entry
// completely, also inside one file. With no `watchdogs` key in any file, the default watchdog.
const mergeWatchdogs = (files: readonly ParsedFile[], maxNotesPerReview: number): Watchdog[] => {
  const lists = files.flatMap((file) => (file.watchdogs === undefined ? [] : [file.watchdogs]));
  if (lists.length === 0) {
    return [{ ...DEFAULT_WATCHDOG, maxNotesPerReview }];
  }
  const bySlug = new Map<string, ParsedEntry>(lists.flat().map((entry) => [entry.slug, entry]));
  return Array.from(bySlug.values(), (entry) => ({
    ...entry,
    maxNotesPerReview: entry.maxNotesPerReview ?? maxNotesPerReview,
  }));
};

// §4.2: the files in load order (§4.3) make one roster.
export const mergeRoster = (files: readonly ParsedFile[]): Roster => {
  const maxNotesPerReview =
    files.findLast((file) => file.maxNotesPerReview !== undefined)?.maxNotesPerReview ??
    DEFAULT_WATCHDOG.maxNotesPerReview;
  const instructions = files.flatMap((file) => {
    const text = file.instructions?.trim() ?? '';
    return text === '' ? [] : [text];
  });
  return {
    watchdogs: mergeWatchdogs(files, maxNotesPerReview),
    instructions: instructions.length === 0 ? null : instructions.join('\n\n'),
    subagents: mergeSubagents(files),
    warnings: files.flatMap((file) => file.warnings),
  };
};

// §4.3, §4.6: the files that `$` read, in load order; a file that cannot be read is skipped with a warning.
export const buildRoster = (files: readonly LoadedFile[], where: Where): Roster =>
  mergeRoster(
    files.flatMap(({ path, isUser, content }) => {
      const label = displayPath(path, where);
      if (content === undefined) {
        return [];
      }
      return 'error' in content
        ? [skippedFile(`${label}: cannot be read; file skipped (${content.error})`)]
        : [parseRosterFile({ label, isUser, text: content.text })];
    })
  );
