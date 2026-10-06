// §13.3: `/watchdog status` is a first line plus the lines each area adds.
// An area adds its lines once, in its `installX(on)`; they show in install order.
export type StatusLines = () => readonly string[];

const sections = new Set<StatusLines>();

export const addStatusLines = (lines: StatusLines): void => {
  sections.add(lines);
};

export const statusText = (headline: string): string =>
  [headline, ...Array.from(sections, (lines) => lines()).flat()].join('\n');
