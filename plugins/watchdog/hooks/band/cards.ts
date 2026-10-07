import { watchdogBySlug } from '../agents/roster';
import { normalizeNote } from '../note/guard';
import { editsSince } from '../note/outdated';
import type { HeldNote } from '../note/notes';
import type { Severity } from '../note/tool';
import type { PluginState } from 'claude-code';

// §13.1: the band's cards and session totals (the shape of the `band` key of the state contract).
export type Band = PluginState['watchdog']['band'];

export type Card = Band['cards'][number];

export const EMPTY_BAND: Band = {
  cards: [],
  totals: { blocker: 0, concern: 0, nit: 0 },
  turn: 0,
  seq: 0,
  expanded: null,
};

// The live band is module memory; `$.state` key `band` keeps a copy, which the band hook draws.
const memory: { band: Band } = { band: EMPTY_BAND };

// §9.1, §11.4: the guard tells notes of one watchdog on one watched agent apart by their normalized text.
export const cardKey = (note: Pick<HeldNote, 'watchdog' | 'text' | 'subagent'>): string =>
  `${note.watchdog}\n${note.subagent?.agentId ?? ''}\n${normalizeNote(note.text)}`;

const count = (totals: Band['totals'], severity: Severity, by: number): Band['totals'] => ({
  ...totals,
  [severity]: totals[severity] + by,
});

// §13.1: the band as `$.state` keeps it, with the main-loop turn counter that the card ages count from. With
// no card the turn stays 0, so a new turn alone writes nothing. §10.8: each card counts the edits since its batch
// now, so a new edit on a file a card names draws the band again.
export const bandState = (turn: number): Band => ({
  ...memory.band,
  cards: memory.band.cards.map((card) => ({ ...card, edits: editsSince(card) })),
  turn: memory.band.cards.length === 0 ? 0 : turn,
});

// §13.1: the cards as they show now.
export const currentCards = (): readonly Card[] => memory.band.cards;

// §13.1, §11.3: an admitted note becomes the newest card and counts in the session totals; a note on a
// subagent shows its type. §10.8: the card keeps the note's batch and counts the edits since it.
export const addCard = (note: HeldNote): void => {
  const { band } = memory;
  const batched = {
    text: note.text,
    batchEnd: note.batchEnd,
    ...(note.subagent === undefined ? {} : { subagentId: note.subagent.agentId }),
  };
  const card: Card = {
    key: cardKey(note),
    seq: band.seq + 1,
    name: watchdogBySlug(note.watchdog)?.name ?? note.watchdog,
    severity: note.severity,
    turn: note.turn,
    delivery: note.delivery,
    ...(note.subagent === undefined ? {} : { subagent: note.subagent.type }),
    watchdog: note.watchdog,
    ...batched,
    edits: editsSince(batched),
  };
  memory.band = {
    ...band,
    cards: [...band.cards.filter((shown) => shown.key !== card.key), card],
    totals: count(band.totals, note.severity, 1),
    seq: card.seq,
  };
};

// §13.1: a card shows the delivery state its note has now; a raise (§9.1) moves the note to its new severity,
// in the totals too. §10.8: a note that takes a later review's batch takes its turn too.
export const changeCard = (before: HeldNote | undefined, after: HeldNote): void => {
  const { band } = memory;
  const raised = before !== undefined && before.severity !== after.severity ? before.severity : undefined;
  const key = cardKey(before ?? after);
  const change = { severity: after.severity, delivery: after.delivery, batchEnd: after.batchEnd, turn: after.turn };
  memory.band = {
    ...band,
    cards: band.cards.map((card) => (card.key === key ? { ...card, ...change } : card)),
    totals: raised === undefined ? band.totals : count(count(band.totals, raised, -1), after.severity, 1),
  };
};

// §10.8: the card of a delivered note takes the batch of a later review that sent its text again.
export const renewCard = (key: string, batch: Pick<Card, 'batchEnd' | 'turn'>): void => {
  const { band } = memory;
  const renewed = (card: Card): Card => ({ ...card, batchEnd: batch.batchEnd, turn: batch.turn });
  memory.band = { ...band, cards: band.cards.map((card) => (card.key === key ? renewed(card) : card)) };
};

// §9.4, §11.4, §10.8: a card leaves the band when its note goes undelivered (displaced, a late repeat on a
// subagent, superseded) or a later review supersedes its delivered note; the totals keep it, as the session totals
// count each admitted note. An expanded card collapses as it leaves.
export const removeCard = (key: string): void => {
  const { band } = memory;
  memory.band = {
    ...band,
    cards: band.cards.filter((card) => card.key !== key),
    expanded: band.expanded === key ? null : band.expanded,
  };
};

// §13.1, §5.2: a person prompt and `/watchdog off` clear the cards and collapse the expanded one; the totals stay
// for the count line.
export const clearCards = (): void => {
  memory.band = { ...memory.band, cards: [], expanded: null };
};

// §13.1: a press on a card expands its whole body and collapses the card expanded before; a press on the expanded
// card collapses it. A press on a card that left the band since it was drawn changes nothing.
export const toggleCard = (key: string): void => {
  const { band } = memory;
  if (!band.cards.some((card) => card.key === key)) {
    return;
  }
  memory.band = { ...band, expanded: band.expanded === key ? null : key };
};

// §14.6: at module load the band comes back from `$.state`, the expanded card with it.
export const restoreBand = (band: Band): void => {
  memory.band = band;
};
