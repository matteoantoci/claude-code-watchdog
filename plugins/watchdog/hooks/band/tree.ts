import { BAND_CARD_LIMIT, BAND_LINE_COLUMNS, BAND_TINY_COLUMNS, BAND_TINY_TEXT_MAX } from '../constants';
import { severityRank } from '../note/tool';
import type { Severity } from '../note/tool';
import type { Band, Card } from './cards';
import type { Elements, RenderChildren, RenderElement } from 'claude-code';

// §13.1: only `Box`, `Text` and `Markdown`; the terminal and the desktop tables both have them.
export type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown'>;

// What the band draws: the on flag (undefined before any), the cards, the failure line (§12.5) and
// `props.bodyColumns`.
export type BandView = {
  readonly isOn: boolean | undefined;
  readonly band: Band;
  readonly trouble: string | undefined;
  readonly columns: number;
};

// §13.1: full cards, one line for each note below 80 `bodyColumns`, the cut text below 50.
type Mode = 'full' | 'line' | 'tiny';

type Totals = Band['totals'];

// §13.1: the count line and the `+N more` line name the severities in this order.
const SEVERITIES: readonly Severity[] = ['blocker', 'concern', 'nit'];

// §13.1: theme keys, not raw colors (prototype `SEV_COLOR`): red, yellow, gray.
const COLORS: Readonly<Record<Severity, string>> = { blocker: 'error', concern: 'warning', nit: 'inactive' };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

// §13.1: one line of a note: no code ticks, a list item after a `; `, no line breaks (prototype `flat`).
const flat = (text: string): string =>
  text
    .replaceAll('`', '')
    .replace(/\n-\s*/gu, '; ')
    .replace(/\s+/gu, ' ')
    .trim();

// §10.7: the age of a note in main-loop turns (prototype `ago`).
const ago = (turn: number, now: number): string => {
  const turns = now - turn;
  return turns <= 0 ? 'just now' : `${plural(turns, 'turn')} ago`;
};

const severityText = (el: BandElements, severity: Severity, text: string): RenderElement =>
  el.Text({ color: COLORS[severity], bold: severity !== 'nit', dimColor: severity === 'nit', children: text });

// `1 blocker · 3 concerns · 1 nit`, each in its color; a severity with no note is left out.
const severityParts = (el: BandElements, totals: Totals): RenderChildren[] =>
  SEVERITIES.filter((severity) => totals[severity] > 0).flatMap((severity, index) => [
    index === 0 ? '' : ' · ',
    severityText(el, severity, plural(totals[severity], severity)),
  ]);

const totalsOf = (cards: readonly Card[]): Totals => ({
  blocker: cards.filter((card) => card.severity === 'blocker').length,
  concern: cards.filter((card) => card.severity === 'concern').length,
  nit: cards.filter((card) => card.severity === 'nit').length,
});

// §13.1: the first row counts the notes of the session; the cut form only their number.
const countLine = (el: BandElements, totals: Totals, mode: Mode): RenderElement => {
  const total = totals.blocker + totals.concern + totals.nit;
  if (mode === 'tiny') {
    return el.Text({ dimColor: true, wrap: 'truncate-end', children: `watchdog · ${plural(total, 'note')}` });
  }
  const parts = total === 0 ? [el.Text({ dimColor: true, children: 'no notes' })] : severityParts(el, totals);
  return el.Text({ wrap: 'truncate-end', children: [el.Text({ dimColor: true, children: 'watchdog · ' }), ...parts] });
};

// §13.1, §11.3: the severity badge (a colored background with `inverseText`), the watchdog, a subagent's
// type, the age and the delivery state.
const header = (el: BandElements, card: Card, turn: number): RenderElement => {
  const color = COLORS[card.severity];
  const badge = el.Text({
    backgroundColor: color,
    color: 'inverseText',
    bold: card.severity !== 'nit',
    children: ` ${card.severity.toUpperCase()} `,
  });
  const facts = [...(card.subagent === undefined ? [] : [card.subagent]), ago(card.turn, turn), card.delivery];
  return el.Text({
    wrap: 'truncate-end',
    children: [
      badge,
      ' ',
      el.Text({ bold: true, children: card.name }),
      el.Text({ dimColor: true, children: ` · ${facts.join(' · ')}` }),
    ],
  });
};

// §13.1: a full card, or one line `[<severity>] <text>`; below 50 columns the text is cut to
// `min(40, bodyColumns - tag - 1)` characters, so the row fills `bodyColumns`.
const cardOf = (el: BandElements, card: Card, view: { mode: Mode; columns: number; turn: number }): RenderElement => {
  if (view.mode === 'full') {
    const body = el.Box({ marginLeft: 2, children: [el.Markdown({ text: card.text })] });
    return el.Box({ flexDirection: 'column', children: [header(el, card, view.turn), body] });
  }
  const tag = `[${[card.severity, ...(card.subagent === undefined ? [] : [card.subagent])].join(' · ')}]`;
  const text = flat(card.text);
  const max = Math.min(BAND_TINY_TEXT_MAX, view.columns - tag.length - 1);
  const shown = view.mode === 'tiny' && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  return el.Text({ wrap: 'truncate-end', children: [severityText(el, card.severity, tag), ` ${shown}`] });
};

const row = (el: BandElements, key: string, child: RenderElement): RenderElement =>
  el.Box({ key, flexDirection: 'column', children: [child] });

const modeOf = (columns: number): Mode => {
  if (columns < BAND_TINY_COLUMNS) {
    return 'tiny';
  }
  return columns < BAND_LINE_COLUMNS ? 'line' : 'full';
};

// §13.1, §12.5, §5.2: the count line, the failure line, the first 3 notes by severity then newest, and
// `+N more: <severities>`; one dim line after `/watchdog off`; nothing before the session was ever on.
export const bandTree = (el: BandElements, view: BandView): RenderElement | undefined => {
  if (view.isOn === false) {
    return row(el, 'watchdog-off', el.Text({ dimColor: true, children: 'watchdog · off · /watchdog on' }));
  }
  if (view.isOn !== true) {
    return undefined;
  }
  const mode = modeOf(view.columns);
  const sorted = view.band.cards.toSorted(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.seq - a.seq
  );
  const hidden = sorted.slice(BAND_CARD_LIMIT);
  const more = el.Text({
    wrap: 'truncate-end',
    children: [
      el.Text({ dimColor: true, children: `  +${hidden.length} more: ` }),
      ...severityParts(el, totalsOf(hidden)),
    ],
  });
  const cardView = { mode, columns: view.columns, turn: view.band.turn };
  return el.Box({
    flexDirection: 'column',
    children: [
      row(el, 'watchdog-count', countLine(el, view.band.totals, mode)),
      view.trouble === undefined
        ? null
        : row(el, 'watchdog-trouble', el.Text({ color: 'error', wrap: 'truncate-end', children: view.trouble })),
      ...sorted
        .slice(0, BAND_CARD_LIMIT)
        .map((card, index) => row(el, `watchdog-card-${index}`, cardOf(el, card, cardView))),
      hidden.length === 0 ? null : row(el, 'watchdog-more', more),
    ],
  });
};
