// §13.3: `/watchdog status` is a first line plus the lines each area adds. The first line is the on state
// and the parts each area adds (`nudge 1/1`, `cooldown 3`, …), joined with ` · `.
// An area adds its parts and lines once, in its `installX(on)`; they show in install order.
export type StatusLines = () => readonly string[];

const heads = new Set<StatusLines>();
const sections = new Set<StatusLines>();

export const addStatusHead = (parts: StatusLines): void => {
  heads.add(parts);
};

export const addStatusLines = (lines: StatusLines): void => {
  sections.add(lines);
};

export const statusText = (headline: string): string =>
  [
    [headline, ...Array.from(heads, (parts) => parts()).flat()].join(' · '),
    ...Array.from(sections, (lines) => lines()).flat(),
  ].join('\n');
