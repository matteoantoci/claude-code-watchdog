import { BAND_CARD_GAP } from '../constants';

// §13.1: the rows a full band takes: those of each card body, one for each other line (the count line, the
// failure line, the card headers, `+N more`), and the gaps between the cards, of `BAND_CARD_GAP` blank rows each.
export type BandRows = { readonly bodies: readonly number[]; readonly lines: number; readonly gaps: number };

// §13.1: which card bodies show cut to one line, and whether the blank rows between the cards stay.
export type BandFit = { readonly cut: readonly boolean[]; readonly hasGaps: boolean };

type Wrap = { readonly rows: number; readonly used: number };

// One word placed on the rows: on the current row after a space when it fits, else from a new row; a word
// wider than a row breaks across rows.
const place = (at: Wrap, word: string, columns: number): Wrap => {
  const after = at.used === 0 ? word.length : at.used + 1 + word.length;
  if (after <= columns) {
    return { rows: at.rows, used: after };
  }
  const breaks = Math.max(0, Math.ceil(word.length / columns) - 1);
  return { rows: at.rows + (at.used === 0 ? 0 : 1) + breaks, used: word.length - breaks * columns };
};

// §13.1: an estimate of the rows a note takes as Markdown in `columns` cells: each line of its text wraps at
// word ends. Markdown draws no code ticks; its other marks count as cells, so a body may be estimated taller.
export const wrappedRows = (text: string, columns: number): number =>
  text
    .replaceAll('`', '')
    .trim()
    .split('\n')
    .reduce(
      (rows, line) => rows + line.split(' ').reduce((at, word) => place(at, word, columns), { rows: 1, used: 0 }).rows,
      0
    );

// §13.1: a band taller than `maxRows` cuts the bodies of the cards below the top one to one line, the last
// card first, until it fits; then it drops the blank rows. The top card keeps its whole body: a band still
// too tall scrolls in the engine's window. With no `maxRows`, every body stays whole.
export const fitBand = (rows: BandRows, maxRows: number | undefined): BandFit => {
  const whole = rows.bodies.map(() => false);
  if (maxRows === undefined) {
    return { cut: whole, hasGaps: true };
  }
  const total = rows.lines + rows.gaps * BAND_CARD_GAP + rows.bodies.reduce((sum, body) => sum + body, 0);
  const fitted = rows.bodies.reduceRight(
    (at, body, index) =>
      at.over <= 0 || index === 0 || body <= 1 ? at : { cut: at.cut.with(index, true), over: at.over - body + 1 },
    { cut: whole, over: total - maxRows }
  );
  return { cut: fitted.cut, hasGaps: fitted.over <= 0 };
};
