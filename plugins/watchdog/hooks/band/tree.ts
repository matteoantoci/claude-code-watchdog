import {
  BAND_CARD_HOTKEYS,
  BAND_CARD_INDENT,
  BAND_CARD_LIMIT,
  BAND_LINE_COLUMNS,
  BAND_RULE_EDGE,
  BAND_TINY_COLUMNS,
  BAND_TINY_TEXT_MAX,
} from '../constants';
import { outdatedMark } from '../note/outdated';
import { severityRank } from '../note/tool';
import type { Severity } from '../note/tool';
import type { Band, Card } from './cards';
import type { Elements, RenderChildren, RenderElement } from 'claude-code';

// §13.1: only `Box`, `Text`, `Markdown` and `Button`; the terminal and the desktop tables have all four.
export type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown' | 'Button'>;

// What the band draws: the on flag (undefined before any), the cards, the failure line (§12.5),
// `props.bodyColumns`, and what a press on a full card runs, with the card's `key`.
export type BandView = {
  readonly isOn: boolean | undefined;
  readonly band: Band;
  readonly trouble: string | undefined;
  readonly columns: number;
  readonly onToggle: (key: string) => void;
};

// §13.1: full cards, one line `[<severity>] <text>` for each note below 80 `bodyColumns`, the cut text below 50.
type Mode = 'full' | 'line' | 'tiny';

// The number of cards of each severity.
type Counts = Readonly<Record<Severity, number>>;

// §13.1: a rule title as text, for its width, and as the elements that draw it.
type Title = { readonly text: string; readonly parts: readonly RenderChildren[] };

// §13.1: the count line and the `+N more` line name the severities in this order.
const SEVERITIES: readonly Severity[] = ['blocker', 'concern', 'nit'];

// §13.1: theme keys, not raw colors (prototype `SEV_COLOR`): red, yellow, gray.
const COLORS: Readonly<Record<Severity, string>> = { blocker: 'error', concern: 'warning', nit: 'inactive' };

// §13.1: the first sentence of a note's first line: up to the first `.`, `?` or `!` that a space follows, outside a
// code span.
const SENTENCE = /^(?:`[^`]*`|[^`])*?[.!?](?= )/u;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

// §13.1: one line of a note: no code ticks, a list item after a `; `, no line breaks (prototype `flat`).
const flat = (text: string): string =>
  text
    .replaceAll('`', '')
    .replace(/\n-\s*/gu, '; ')
    .replace(/\s+/gu, ' ')
    .trim();

// §13.1: the text of a collapsed full card: the first sentence of the note, flat; with none, its whole first line.
export const firstSentence = (text: string): string => {
  const [line = ''] = text.trim().split('\n');
  return flat(SENTENCE.exec(line)?.[0] ?? line);
};

// §10.7: the age of a note in main-loop turns (prototype `ago`).
const ago = (turn: number, now: number): string => {
  const turns = now - turn;
  return turns <= 0 ? 'just now' : `${plural(turns, 'turn')} ago`;
};

const severityText = (el: BandElements, severity: Severity, text: string): RenderElement =>
  el.Text({ color: COLORS[severity], bold: severity !== 'nit', dimColor: severity === 'nit', children: text });

// `1 blocker · 3 concerns · 1 nit`; a severity with no card is left out. The rule measures this text, so its
// width and the drawn counts (`severityParts`) come from one list.
const counted = (counts: Counts): { readonly severity: Severity; readonly text: string }[] =>
  SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => ({
    severity,
    text: plural(counts[severity], severity),
  }));

// The counts of `counted`, each in its color.
const severityParts = (el: BandElements, counts: Counts): RenderChildren[] =>
  counted(counts).flatMap(({ severity, text }, index) => [index === 0 ? '' : ' · ', severityText(el, severity, text)]);

const countsOf = (cards: readonly Card[]): Counts => ({
  blocker: cards.filter((card) => card.severity === 'blocker').length,
  concern: cards.filter((card) => card.severity === 'concern').length,
  nit: cards.filter((card) => card.severity === 'nit').length,
});

// §13.1: the focus hint at the right end of the count line: the chord that gives the band the focus, then the
// hotkeys of the shown cards.
const focusHint = (cards: number): string => `ctrl+x tab · ${BAND_CARD_HOTKEYS.slice(0, cards).join('/')}`;

// §13.1: the dim rest of the rule after the title, `tail` cells with its first space: the focus hint when it fits
// with a space and at least `BAND_RULE_EDGE` rule cells on each side, else the rule alone.
const ruleTail = (tail: number, hint: string | undefined): string => {
  const end = hint === undefined ? '' : ` ${hint} ${'─'.repeat(BAND_RULE_EDGE)}`;
  const shown = tail - 1 - end.length < BAND_RULE_EDGE ? '' : end;
  return ` ${'─'.repeat(tail - 1 - shown.length)}${shown}`;
};

// §13.1: a dim rule across `bodyColumns`: `BAND_RULE_EDGE` rule cells and a space, the title, a space and the rest
// of the rule, which holds the focus hint when it fits. A title with no room for `BAND_RULE_EDGE` rule cells on
// each side shows alone, cut at the end.
const ruled = (el: BandElements, title: Title, at: { columns: number; hint?: string | undefined }): RenderElement => {
  const tail = at.columns - (BAND_RULE_EDGE + 1) - title.text.length;
  const parts =
    tail - 1 < BAND_RULE_EDGE
      ? title.parts
      : [
          el.Text({ dimColor: true, children: `${'─'.repeat(BAND_RULE_EDGE)} ` }),
          ...title.parts,
          el.Text({ dimColor: true, children: ruleTail(tail, at.hint) }),
        ];
  return el.Text({ wrap: 'truncate-end', children: parts });
};

// §13.1: the first row counts the open cards, those under `+N more` too, so a card that leaves lowers it; the cut
// form only their number.
const countTitle = (el: BandElements, cards: readonly Card[], mode: Mode): Title => {
  if (cards.length === 0) {
    const text = 'watchdog · no open notes';
    return { text, parts: [el.Text({ dimColor: true, children: text })] };
  }
  if (mode === 'tiny') {
    const text = `watchdog · ${plural(cards.length, 'note')}`;
    return { text, parts: [el.Text({ dimColor: true, children: text })] };
  }
  const counts = countsOf(cards);
  const lead = el.Text({ dimColor: true, children: 'watchdog · ' });
  return {
    text: `watchdog · ${counted(counts)
      .map(({ text }) => text)
      .join(' · ')}`,
    parts: [lead, ...severityParts(el, counts)],
  };
};

// §13.1, §11.3: the severity badge (a colored background with `inverseText`), the watchdog, a subagent's type, the
// outdated mark (§10.8), the first sentence of a collapsed card, the age (from the band's `turn`) and the delivery
// state, on one line cut at the end.
const header = (el: BandElements, card: Card, at: { turn: number; sentence: string | undefined }): RenderElement => {
  const badge = el.Text({
    backgroundColor: COLORS[card.severity],
    color: 'inverseText',
    bold: card.severity !== 'nit',
    children: ` ${card.severity.toUpperCase()} `,
  });
  const dim = (text: string): RenderElement => el.Text({ dimColor: true, children: text });
  const mark = outdatedMark(card.edits);
  return el.Text({
    wrap: 'truncate-end',
    children: [
      badge,
      ' ',
      el.Text({ bold: true, children: card.name }),
      ...(card.subagent === undefined ? [] : [dim(` · ${card.subagent}`)]),
      ...(mark === undefined ? [] : [dim(` · ${mark}`)]),
      ...(at.sentence === undefined ? [] : [dim(' · '), at.sentence]),
      dim(` · ${ago(card.turn, at.turn)} · ${card.delivery}`),
    ],
  });
};

// §13.1: a full card is one row: a plain Button with its letter hotkey (Enter under the focus or a click presses it
// too), then the header. A press expands the card: its header without the sentence, then its whole Markdown body,
// indented; a press on it again collapses it. `index` is the card's place among the shown cards.
const fullCard = (el: BandElements, { card, index }: { card: Card; index: number }, view: BandView): RenderElement => {
  const isExpanded = card.key === view.band.expanded;
  const toggle = el.Button({
    key: `watchdog-expand-${index}`,
    label: isExpanded ? '▾' : '▸',
    hotkey: BAND_CARD_HOTKEYS[index],
    plain: true,
    dimColor: true,
    onPress: () => {
      view.onToggle(card.key);
    },
  });
  const sentence = isExpanded ? undefined : firstSentence(card.text);
  const line = el.Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [toggle, header(el, card, { turn: view.band.turn, sentence })],
  });
  if (!isExpanded) {
    return line;
  }
  const body = el.Box({ marginLeft: BAND_CARD_INDENT, children: [el.Markdown({ text: card.text })] });
  return el.Box({ flexDirection: 'column', children: [line, body] });
};

// §13.1: one line `[<severity>] <text>`; below 50 columns the text is cut to `min(40, bodyColumns - tag - 1)`
// characters, so the row fills `bodyColumns`.
const lineCard = (el: BandElements, card: Card, { mode, columns }: { mode: Mode; columns: number }): RenderElement => {
  const tag = `[${[card.severity, ...(card.subagent === undefined ? [] : [card.subagent])].join(' · ')}]`;
  const text = flat(card.text);
  const max = Math.min(BAND_TINY_TEXT_MAX, columns - tag.length - 1);
  const shown = mode === 'tiny' && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
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

// §13.1: the first 3 notes by severity then newest, and `+N more: <severities>`, one row each but an expanded card.
const cardList = (el: BandElements, view: BandView, mode: Mode): RenderElement[] => {
  const sorted = view.band.cards.toSorted(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.seq - a.seq
  );
  const hidden = sorted.slice(BAND_CARD_LIMIT);
  const cards = sorted
    .slice(0, BAND_CARD_LIMIT)
    .map((card, index) =>
      row(
        el,
        `watchdog-card-${index}`,
        mode === 'full' ? fullCard(el, { card, index }, view) : lineCard(el, card, { mode, columns: view.columns })
      )
    );
  if (hidden.length === 0) {
    return cards;
  }
  const more = el.Text({
    wrap: 'truncate-end',
    children: [
      el.Text({ dimColor: true, children: `  +${hidden.length} more: ` }),
      ...severityParts(el, countsOf(hidden)),
    ],
  });
  return [...cards, row(el, 'watchdog-more', more)];
};

// §13.1, §12.5: the failure line, then the cards, under one blank row that parts them from the count line. No blank
// row when neither shows: the engine keeps its own blank row between the band and the prompt.
const bandBody = (el: BandElements, view: BandView, mode: Mode): RenderElement[] => {
  const trouble =
    view.trouble === undefined
      ? []
      : [row(el, 'watchdog-trouble', el.Text({ color: 'error', wrap: 'truncate-end', children: view.trouble }))];
  const rows = [...trouble, ...cardList(el, view, mode)];
  return rows.length === 0 ? [] : [el.Box({ marginTop: 1, flexDirection: 'column', children: rows })];
};

// §13.1, §12.5, §5.2: the count line, the failure line, then the cards; one dim line after `/watchdog off`;
// nothing before the session was ever on. The count line is the first row: the engine draws its `[-]` there.
export const bandTree = (el: BandElements, view: BandView): RenderElement | undefined => {
  if (view.isOn === false) {
    const off = 'watchdog · off · /watchdog on';
    const title = { text: off, parts: [el.Text({ dimColor: true, children: off })] };
    return row(el, 'watchdog-off', ruled(el, title, { columns: view.columns }));
  }
  if (view.isOn !== true) {
    return undefined;
  }
  const mode = modeOf(view.columns);
  // §13.1: the focus hint only over full cards, which have a Button each.
  const buttons = mode === 'full' ? Math.min(view.band.cards.length, BAND_CARD_LIMIT) : 0;
  const count = ruled(el, countTitle(el, view.band.cards, mode), {
    columns: view.columns,
    hint: buttons === 0 ? undefined : focusHint(buttons),
  });
  return el.Box({ flexDirection: 'column', children: [row(el, 'watchdog-count', count), ...bandBody(el, view, mode)] });
};
