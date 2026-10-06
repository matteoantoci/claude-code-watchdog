import { watchdogBySlug } from '../agents/roster';
import { normalizeNote } from '../note/guard';
import type { DeliveryState, HeldNote } from '../note/notes';
import type { Severity } from '../note/tool';
import type { PluginState } from 'claude-code';

// §13.1: the band's cards and session totals (the shape of the `band` key of the state contract).
export type Band = PluginState['watchdog']['band'];

export type Card = Band['cards'][number];

export const EMPTY_BAND: Band = { cards: [], totals: { blocker: 0, concern: 0, nit: 0 }, turn: 0, seq: 0 };

// The live band is module memory; `$.state` key `band` keeps a copy, which the band hook draws.
const memory: { band: Band } = { band: EMPTY_BAND };

// §9.1: the guard tells notes of one watchdog apart by their normalized text.
const cardKey = (note: Pick<HeldNote, 'watchdog' | 'text'>): string => `${note.watchdog}\n${normalizeNote(note.text)}`;

const count = (totals: Band['totals'], severity: Severity, by: number): Band['totals'] => ({
  ...totals,
  [severity]: totals[severity] + by,
});

// §13.1: the band as `$.state` keeps it, with the main-loop turn counter that the card ages count from. With
// no card the turn stays 0, so a new turn alone writes nothing.
export const bandState = (turn: number): Band => ({
  ...memory.band,
  turn: memory.band.cards.length === 0 ? 0 : turn,
});

// §13.1: an admitted note becomes the newest card and counts in the session totals.
export const addCard = (note: HeldNote): void => {
  const { band } = memory;
  const card: Card = {
    key: cardKey(note),
    seq: band.seq + 1,
    name: watchdogBySlug(note.watchdog)?.name ?? note.watchdog,
    severity: note.severity,
    text: note.text,
    turn: note.turn,
    delivery: note.delivery,
  };
  memory.band = {
    ...band,
    cards: [...band.cards.filter((shown) => shown.key !== card.key), card],
    totals: count(band.totals, note.severity, 1),
    seq: card.seq,
  };
};

// §13.1: a card shows the delivery state its note has now; a raise (§9.1) moves the note to its new severity,
// in the totals too.
export const changeCard = (before: HeldNote | undefined, after: HeldNote): void => {
  const { band } = memory;
  const raised = before !== undefined && before.severity !== after.severity ? before.severity : undefined;
  const key = cardKey(before ?? after);
  memory.band = {
    ...band,
    cards: band.cards.map((card) =>
      card.key === key ? { ...card, severity: after.severity, delivery: after.delivery } : card
    ),
    totals: raised === undefined ? band.totals : count(count(band.totals, raised, -1), after.severity, 1),
  };
};

// §9.4: a displaced note leaves the held list; its card says so.
export const markCard = (note: HeldNote, delivery: DeliveryState): void => {
  const key = cardKey(note);
  memory.band = {
    ...memory.band,
    cards: memory.band.cards.map((card) => (card.key === key ? { ...card, delivery } : card)),
  };
};

// §13.1, §5.2: a person prompt and `/watchdog off` clear the cards; the totals stay for the count line.
export const clearCards = (): void => {
  memory.band = { ...memory.band, cards: [] };
};

// §14.6: at module load the band comes back from `$.state`.
export const restoreBand = (band: Band): void => {
  memory.band = band;
};
