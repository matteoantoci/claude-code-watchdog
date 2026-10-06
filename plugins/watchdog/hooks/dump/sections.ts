// §13.4: the dump's lines that other areas add (the on source, warnings, …). Each area calls
// `addDumpLines` in its `installX(on)`; the dump shows the lines in install order, before the records.
const sources: (() => readonly string[])[] = [];

export const addDumpLines = (lines: () => readonly string[]): void => {
  sources.push(lines);
};

export const dumpLines = (): string[] => sources.flatMap((lines) => lines());
