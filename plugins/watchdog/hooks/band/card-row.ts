// §13.1: the row of one band card: a full card (collapsed or expanded) and the one-line form below 80 columns.
import {
  BAND_CARD_HOTKEYS,
  BAND_CARD_INDENT,
  BAND_STATUS_GAP,
  BAND_STATUS_MIN_TEXT,
  BAND_TINY_TEXT_MAX,
} from '../constants';
import { outdatedMark, shortOutdatedMark } from '../note/outdated';
import type { DeliveryState } from '../note/notes';
import type { Severity } from '../note/tool';
import type { Card } from './cards';
import type { Elements, RenderElement } from 'claude-code';

// §13.1: only `Box`, `Text`, `Markdown` and `Button`; the terminal and the desktop tables have all four.
export type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown' | 'Button'>;

// §13.1: full cards, one line `[<severity>] <text>` for each note below 80 `bodyColumns`, the cut text below 50.
export type Mode = 'full' | 'line' | 'tiny';

// What a full card reads of the band: the key of the expanded card, the band's turn, whether a collapsed card names
// its watchdog, and what a press runs, with the card's `key`.
export type FullCardView = {
  readonly expanded: string | null;
  readonly turn: number;
  readonly isNamed: boolean;
  readonly onToggle: (key: string) => void;
};

// §13.1: theme keys, not raw colors (prototype `SEV_COLOR`): red, yellow, gray.
const COLORS: Readonly<Record<Severity, string>> = { blocker: 'error', concern: 'warning', nit: 'inactive' };

// §13.1: the first sentence of a note's first line: up to the first `.`, `?` or `!` that a space follows, outside a
// code span.
const SENTENCE = /^(?:`[^`]*`|[^`])*?[.!?](?= )/u;

// §13.1: the delivery states that a row's status shortens: none (empty) for a note the agent has, `aside` for one that
// it reads only with the next person prompt. Every other state shows as it is (`held`, `nudge pending`).
const SHORT_STATES: Readonly<Record<string, string>> = {
  steered: '',
  nudged: '',
  'aside on next prompt': 'aside',
} satisfies Partial<Record<DeliveryState, string>>;

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

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

export const severityText = (el: BandElements, severity: Severity, text: string): RenderElement =>
  el.Text({ color: COLORS[severity], bold: severity !== 'nit', dimColor: severity === 'nit', children: text });

const dim = (el: BandElements, text: string): RenderElement => el.Text({ dimColor: true, children: text });

// §13.1: the severity badge, a colored background with `inverseText`.
const badge = (el: BandElements, severity: Severity): RenderElement =>
  el.Text({
    backgroundColor: COLORS[severity],
    color: 'inverseText',
    bold: severity !== 'nit',
    children: ` ${severity.toUpperCase()} `,
  });

// §13.1, §11.3, §10.8: the status of a collapsed card row holds only what needs a look: a subagent's type (not on a
// one-line card, whose tag has it), a delivery state that has not reached the agent, the short outdated mark.
const statusOf = (card: Card, { hasType }: { hasType: boolean }): string =>
  [hasType ? card.subagent : undefined, SHORT_STATES[card.delivery] ?? card.delivery, shortOutdatedMark(card.edits)]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');

// §13.1: a card row: the lead, cut at the end to the cells the row leaves it, then the dim status flush right at
// `bodyColumns`, never cut, at least `BAND_STATUS_GAP` blank cells after the lead. The lead alone with no status.
const withStatus = (el: BandElements, lead: RenderElement, status: string): RenderElement => {
  if (status === '') {
    return lead;
  }
  const column = el.Box({ flexShrink: 0, children: [dim(el, `${' '.repeat(BAND_STATUS_GAP)}${status}`)] });
  return el.Box({
    flexDirection: 'row',
    flexGrow: 1,
    flexShrink: 1,
    children: [el.Box({ flexGrow: 1, flexShrink: 1, children: [lead] }), column],
  });
};

// §13.1: a collapsed card's lead: the badge, the watchdog when the band names it, then the first sentence of the note.
const collapsedLead = (el: BandElements, card: Card, isNamed: boolean): RenderElement =>
  el.Text({
    wrap: 'truncate-end',
    children: [
      badge(el, card.severity),
      ' ',
      ...(isNamed ? [el.Text({ bold: true, children: card.name }), dim(el, ' · ')] : []),
      firstSentence(card.text),
    ],
  });

// §13.1, §11.3, §10.8: an expanded card's header holds every field: the badge, the watchdog, a subagent's type, the
// age (from the band's `turn`), the delivery state and the outdated mark, on one line cut at the end.
const expandedHeader = (el: BandElements, card: Card, turn: number): RenderElement => {
  const parts = [card.subagent, ago(card.turn, turn), card.delivery, outdatedMark(card.edits)].filter(
    (part): part is string => part !== undefined
  );
  return el.Text({
    wrap: 'truncate-end',
    children: [
      badge(el, card.severity),
      ' ',
      el.Text({ bold: true, children: card.name }),
      dim(el, parts.map((part) => ` · ${part}`).join('')),
    ],
  });
};

// §13.1: a full card is one row: a plain Button with its letter hotkey (Enter under the focus or a click presses it
// too), the lead, then the status. A press expands the card: its header with every field, then its whole Markdown
// body, indented; a press on it again collapses it. `index` is the card's place among the shown cards.
export const fullCard = (
  el: BandElements,
  { card, index }: { card: Card; index: number },
  view: FullCardView
): RenderElement => {
  const isExpanded = card.key === view.expanded;
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
  if (!isExpanded) {
    const row = withStatus(el, collapsedLead(el, card, view.isNamed), statusOf(card, { hasType: true }));
    return el.Box({ flexDirection: 'row', columnGap: 1, children: [toggle, row] });
  }
  const line = el.Box({ flexDirection: 'row', columnGap: 1, children: [toggle, expandedHeader(el, card, view.turn)] });
  const body = el.Box({ marginLeft: BAND_CARD_INDENT, children: [el.Markdown({ text: card.text })] });
  return el.Box({ flexDirection: 'column', children: [line, body] });
};

// §13.1: one line `[<severity>] <text>`, then the status when `BAND_STATUS_MIN_TEXT` cells of text stay beside it, so
// the row stays one row. Below 50 columns the text is cut to `min(40, bodyColumns - tag - 1)` characters less the
// status and its gap, so the row fills `bodyColumns`.
export const lineCard = (
  el: BandElements,
  card: Card,
  { mode, columns }: { mode: Mode; columns: number }
): RenderElement => {
  const tag = `[${[card.severity, ...(card.subagent === undefined ? [] : [card.subagent])].join(' · ')}]`;
  const room = columns - tag.length - 1;
  const wanted = statusOf(card, { hasType: false });
  const status = room - BAND_STATUS_GAP - wanted.length >= BAND_STATUS_MIN_TEXT ? wanted : '';
  const text = flat(card.text);
  const max = Math.min(BAND_TINY_TEXT_MAX, room - (status === '' ? 0 : BAND_STATUS_GAP + status.length));
  const shown = mode === 'tiny' && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  const lead = el.Text({ wrap: 'truncate-end', children: [severityText(el, card.severity, tag), ` ${shown}`] });
  return withStatus(el, lead, status);
};
