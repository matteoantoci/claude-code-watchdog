import { currentMode } from '../lifecycle/mode';
import { UNSUPPORTED_REPLY } from './spec';

// §13.3: `/watchdog status` is a first line plus the lines each area adds. The first line is the on state
// and the parts each area adds (`nudge 1/1`, `cooldown 3`, …), joined with ` · `.
// An area adds its parts and lines once, in its `installX(on)`; they show in install order.
export type StatusLines = () => readonly string[];

// Where the status table (§13.3) puts an area's lines: `watchdogs` are the text form of the rows that the
// table draws itself, `error` follows the session row, `line` comes after it.
export type StatusPlace = 'line' | 'watchdogs' | 'error';

const heads = new Set<StatusLines>();
const sections: { readonly lines: StatusLines; readonly place: StatusPlace }[] = [];

export const addStatusHead = (parts: StatusLines): void => {
  heads.add(parts);
};

export const addStatusLines = (lines: StatusLines, place: StatusPlace = 'line'): void => {
  sections.push({ lines, place });
};

export const statusHeadline = (): string =>
  currentMode() === 'unsupported' ? `watchdog unsupported: ${UNSUPPORTED_REPLY}` : `watchdog ${currentMode()}`;

const headParts = (headline: string): string[] => [headline, ...Array.from(heads, (parts) => parts()).flat()];

export const statusText = (headline: string): string =>
  [headParts(headline).join(' · '), ...sections.flatMap((section) => section.lines())].join('\n');

// The status for the table: the parts of the first line, the `error` lines and the `line` lines.
export type StatusSections = {
  readonly head: readonly string[];
  readonly errors: readonly string[];
  readonly lines: readonly string[];
};

const linesAt = (place: StatusPlace): string[] =>
  sections.filter((section) => section.place === place).flatMap((section) => section.lines());

export const statusSections = (headline: string): StatusSections => ({
  head: headParts(headline),
  errors: linesAt('error'),
  lines: linesAt('line'),
});
