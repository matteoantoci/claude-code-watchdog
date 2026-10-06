import { DEFAULT_MAX_NOTES_PER_REVIEW } from '../constants';

// §4.2: one watchdog of the roster, its defaults applied. The agent type is `watchdog:<slug>`.
export type Watchdog = {
  readonly name: string;
  readonly slug: string;
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly string[];
  readonly maxNotesPerReview: number;
};

// §4.2, §6.2, §6.3: with no `watchdogs` list in any loaded file, the roster is this one entry.
export const DEFAULT_WATCHDOG: Watchdog = {
  name: 'default',
  slug: 'default',
  model: 'opus',
  effort: 'medium',
  tools: ['Read', 'Grep', 'Glob'],
  maxNotesPerReview: DEFAULT_MAX_NOTES_PER_REVIEW,
};

// The roster frozen at `/watchdog on` (§4.5), in module memory.
const memory: { roster: readonly Watchdog[] } = { roster: [] };

export const currentRoster = (): readonly Watchdog[] => memory.roster;

export const setRoster = (roster: readonly Watchdog[]): void => {
  memory.roster = roster;
};

export const watchdogBySlug = (slug: string): Watchdog | undefined =>
  memory.roster.find((watchdog) => watchdog.slug === slug);
