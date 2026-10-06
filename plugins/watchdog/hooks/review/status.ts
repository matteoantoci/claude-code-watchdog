import { currentRoster, rosterStatusLines } from '../agents/roster';
import { healthParts, lastErrorLines } from '../failure/state';
import { currentMode } from '../lifecycle/mode';
import { slotLine, slotOf } from './slots';

// §13.3: each watchdog with its state, its failure parts (§12.4) and the file that added it. The status
// table draws these rows itself. Off, the review area adds no line.
export const watchdogStatusLines = (): readonly string[] =>
  currentMode() === 'on'
    ? currentRoster().map((watchdog) =>
        [
          slotLine(watchdog.name, slotOf(watchdog.slug)),
          ...healthParts(watchdog.slug),
          ...(watchdog.source === null ? [] : [watchdog.source]),
        ].join(' · ')
      )
    : [];

// §4.5, §4.6: the roster lines while on.
export const rosterLines = (): readonly string[] => (currentMode() === 'on' ? rosterStatusLines() : []);

// §12.4: the last error while on.
export const lastErrorStatus = (): readonly string[] => (currentMode() === 'on' ? lastErrorLines() : []);
