import { DEFAULT_MAX_NOTES_PER_REVIEW } from '../constants';
import type { EffortSetting } from '../roster/model';

// §7.4: `turn` reviews at each boundary, `agent-end` only at the end of the turn.
export type ReviewMode = 'turn' | 'agent-end';

// §4.2: one watchdog of the roster, its defaults applied. The agent type is `watchdog:<slug>`.
export type Watchdog = {
  readonly name: string;
  readonly slug: string;
  // §4.2: `enabled: false` pauses the watchdog (state `disabled`).
  readonly isEnabled: boolean;
  // §6.2: the model id for the agent spec; with `noModel`, the roster text as written.
  readonly model: string;
  readonly effort: EffortSetting;
  // §6.2: why the model cannot run (another provider, an unknown level); the watchdog is then `no_model`.
  readonly noModel: string | null;
  readonly tools: readonly string[];
  readonly reviewMode: ReviewMode;
  readonly reviewInterval: number;
  readonly maxNotesPerReview: number;
  readonly instructions: string | null;
  // §13.3: the file that added it, as the status names it; null for the default watchdog.
  readonly source: string | null;
};

// §4.2, §6.2, §6.3, §7.4: with no `watchdogs` list in any loaded file, the roster is this one entry.
export const DEFAULT_WATCHDOG: Watchdog = {
  name: 'default',
  slug: 'default',
  isEnabled: true,
  model: 'opus',
  effort: 'medium',
  noModel: null,
  tools: ['Read', 'Grep', 'Glob'],
  reviewMode: 'turn',
  reviewInterval: 1,
  maxNotesPerReview: DEFAULT_MAX_NOTES_PER_REVIEW,
  instructions: null,
  source: null,
};

// §4.2: the merged roster of all loaded files. `subagents` maps a subagent type to `true` (every watchdog)
// or to a list of watchdog slugs (§11.1). `warnings` are the §4.6 warnings of the load.
export type Roster = {
  readonly watchdogs: readonly Watchdog[];
  readonly instructions: string | null;
  readonly subagents: Readonly<Record<string, true | readonly string[]>>;
  readonly warnings: readonly string[];
};

// §4.5: each searched file and its time at the last read; null for a file that was not there.
export type WatchedFile = { readonly path: string; readonly mtimeMs: number | null };

// The roster frozen at `/watchdog on` (§4.5), in module memory, with the files it was read from and
// whether a file time differed at the last check.
const memory: { roster: Roster; files: readonly WatchedFile[]; isChanged: boolean } = {
  roster: { watchdogs: [], instructions: null, subagents: {}, warnings: [] },
  files: [],
  isChanged: false,
};

export const currentRoster = (): readonly Watchdog[] => memory.roster.watchdogs;

export const currentRosterConfig = (): Roster => memory.roster;

export const setRoster = (roster: Roster, files: readonly WatchedFile[]): void => {
  memory.roster = roster;
  memory.files = files;
  memory.isChanged = false;
};

export const watchedFiles = (): readonly WatchedFile[] => memory.files;

// §4.5: "config changed" when a file time differs from the time of the last read.
export const setConfigChanged = (now: readonly WatchedFile[]): void => {
  memory.isChanged = now.some((file, index) => file.mtimeMs !== memory.files[index]?.mtimeMs);
};

// §4.5, §4.6, §13.3: the status lines of the roster.
export const rosterStatusLines = (): string[] => [
  ...(memory.isChanged ? ['config changed: /watchdog off, then /watchdog on to load it'] : []),
  ...memory.roster.warnings.map((warning) => `warning: ${warning}`),
];

export const watchdogBySlug = (slug: string): Watchdog | undefined =>
  memory.roster.watchdogs.find((watchdog) => watchdog.slug === slug);
