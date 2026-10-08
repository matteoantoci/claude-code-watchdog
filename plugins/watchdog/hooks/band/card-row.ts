// §13.1: the row of one band card: a full card (collapsed or expanded) and the one-line form below 80 columns.
import {
  BAND_CARD_HOTKEYS,
  BAND_CARD_INDENT,
  BAND_STATUS_GAP,
  BAND_STATUS_MIN_TEXT,
  BAND_TINY_TEXT_MAX,
} from '../constants';
import { bareOutdatedMark, outdatedMark, shortOutdatedMark } from '../note/outdated';
import type { DeliveryState } from '../note/notes';
import type { Severity } from '../note/tool';
import type { Card } from './cards';
import type { Elements, RenderElement } from 'claude-code';

// §13.1: only `Box`, `Text`, `Markdown` and `Button`; the terminal and the desktop tables have all four.
export type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown' | 'Button'>;

// §13.1: full cards, one line `[<severity>] <text>` for each note below 80 `bodyColumns`, the cut text below 50.
export type Mode = 'full' | 'line' | 'tiny';

// What a full card reads of the band: the key of the expanded card, the band's turn, whether a collapsed card names
// its watchdog, `bodyColumns`, and what a press runs, with the card's `key`.
export type FullCardView = {
  readonly expanded: string | null;
  readonly turn: number;
  readonly isNamed: boolean;
  readonly columns: number;
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

// §13.1: the delivery states that a collapsed full card row shortens further when its sentence needs the cells.
const TIGHT_STATES: Readonly<Record<string, string>> = {
  'nudge pending': 'pending',
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
const badgeText = (severity: Severity): string => ` ${severity.toUpperCase()} `;

const badge = (el: BandElements, severity: Severity): RenderElement =>
  el.Text({
    backgroundColor: COLORS[severity],
    color: 'inverseText',
    bold: severity !== 'nit',
    children: badgeText(severity),
  });

// §13.1: the parts of a status, joined by ` · `; a missing or empty part is left out.
const joined = (parts: readonly (string | undefined)[]): string =>
  parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');

// §13.1: whether a status leaves at least `BAND_STATUS_MIN_TEXT` cells of text in `room` cells, after its gap.
const fits = (room: number, status: string): boolean => room - BAND_STATUS_GAP - status.length >= BAND_STATUS_MIN_TEXT;

// §13.1, §11.3, §10.8: the status of a collapsed full card row holds only what needs a look: a subagent's type, a
// delivery state that has not reached the agent, the short outdated mark. When the sentence would keep fewer than
// `BAND_STATUS_MIN_TEXT` of the `room` cells, the least needed goes first: the type (the expanded header has it),
// then `nudge pending` shortens to `pending`, then the mark to `outdated?`; with still too few cells, no status.
const fullStatus = (card: Card, room: number): string => {
  const state = SHORT_STATES[card.delivery] ?? card.delivery;
  const tight = TIGHT_STATES[state] ?? state;
  const mark = shortOutdatedMark(card.edits);
  const steps = [
    joined([card.subagent, state, mark]),
    joined([state, mark]),
    joined([tight, mark]),
    joined([tight, bareOutdatedMark(card.edits)]),
  ];
  return steps.find((status) => status === '' || fits(room, status)) ?? '';
};

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

// §13.1: the watchdog and its ` · ` of a collapsed card's lead, when the band names it.
const NAME_SEPARATOR = ' · ';

// §13.1: a collapsed card's lead: the badge, the watchdog when the band names it, then the first sentence of the note.
const collapsedLead = (el: BandElements, card: Card, isNamed: boolean): RenderElement =>
  el.Text({
    wrap: 'truncate-end',
    children: [
      badge(el, card.severity),
      ' ',
      ...(isNamed ? [el.Text({ bold: true, children: card.name }), dim(el, NAME_SEPARATOR)] : []),
      firstSentence(card.text),
    ],
  });

// §13.1: the cells of a collapsed full card row before its sentence: the Button as the terminal draws a plain one
// (`a: ▸`, d.ts ButtonProps `plain`), the gap after it, the badge and its blank, the watchdog and ` · ` when named.
const sentenceStart = (card: Card, toggle: string, isNamed: boolean): number =>
  toggle.length + 1 + badgeText(card.severity).length + 1 + (isNamed ? card.name.length + NAME_SEPARATOR.length : 0);

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
  const label = isExpanded ? '▾' : '▸';
  const hotkey = BAND_CARD_HOTKEYS[index];
  const toggle = el.Button({
    key: `watchdog-expand-${index}`,
    label,
    hotkey,
    plain: true,
    dimColor: true,
    onPress: () => {
      view.onToggle(card.key);
    },
  });
  if (!isExpanded) {
    const drawn = hotkey === undefined ? label : `${hotkey}: ${label}`;
    const status = fullStatus(card, view.columns - sentenceStart(card, drawn, view.isNamed));
    const row = withStatus(el, collapsedLead(el, card, view.isNamed), status);
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
  const wanted = joined([SHORT_STATES[card.delivery] ?? card.delivery, shortOutdatedMark(card.edits)]);
  const status = fits(room, wanted) ? wanted : '';
  const text = flat(card.text);
  const max = Math.min(BAND_TINY_TEXT_MAX, room - (status === '' ? 0 : BAND_STATUS_GAP + status.length));
  const shown = mode === 'tiny' && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  const lead = el.Text({ wrap: 'truncate-end', children: [severityText(el, card.severity, tag), ` ${shown}`] });
  return withStatus(el, lead, status);
};
