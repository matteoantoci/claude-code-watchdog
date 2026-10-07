// §10.8: a later review of a watchdog renews or supersedes the outdated notes of that watchdog. Pure: the note
// area's review-end hook writes the log rows and the review log.
import { cardKey, currentCards, removeCard, renewCard } from '../band/cards';
import { currentTurn } from '../delivery/turns';
import { batchTurn } from '../feed/feed';
import { markLoggedNote } from '../log/log';
import { runningReview } from '../review/slots';
import { dropHeldNote } from './drop';
import { normalizeNote } from './guard';
import { changeLiveHistory, forgetGuardKey, updateNote } from './history';
import { heldNotes, replaceHeldNote } from './notes';
import { batchedOf, fateOf, watchedFeed } from './outdated';
import type { HeldNote } from './notes';
import type { LaterReview } from './outdated';

export const SUPERSEDED = 'dropped:superseded';

// §10.8: a superseded held note leaves the held list and the band. The record of the review that sent it (the dump)
// and the recap show `dropped:superseded`, and its key leaves the guard keys, so a later review may raise it again.
const supersede = (note: HeldNote): void => {
  const key = normalizeNote(note.text);
  dropHeldNote(note);
  markLoggedNote(note.agentId, note.text, SUPERSEDED);
  changeLiveHistory(note.subagent?.agentId, (history) =>
    forgetGuardKey(updateNote(history, note.watchdog, { key, delivery: SUPERSEDED }), note.watchdog, key)
  );
};

// §10.8: the held notes of the review's watchdog on the watched agent it reviewed take the review's batch, or are
// superseded. Returns the card keys of all of them and the notes superseded.
const settleHeld = (review: LaterReview, turn: number) => {
  const held = heldNotes().filter(
    (note) => note.watchdog === review.slug && note.subagent?.agentId === review.subagentId
  );
  const fates = held.map((note) => ({ note, fate: fateOf(batchedOf(note), review) }));
  fates.forEach(({ note, fate }) => {
    if (fate === 'renew') {
      replaceHeldNote(note, { ...note, batchEnd: review.batchEnd, turn });
    }
  });
  const superseded = fates.filter(({ fate }) => fate === 'supersede').map(({ note }) => note);
  superseded.forEach(supersede);
  return { keys: new Set(held.map(cardKey)), superseded };
};

// §10.8: the card of a delivered note takes the review's batch, or leaves the band; the note keeps its log row.
const settleCards = (review: LaterReview, turn: number, held: ReadonlySet<string>): void => {
  currentCards()
    .filter((card) => card.watchdog === review.slug && card.subagentId === review.subagentId && !held.has(card.key))
    .forEach((card) => {
      const fate = fateOf(card, review);
      if (fate === 'renew') {
        renewCard(card.key, { batchEnd: review.batchEnd, turn });
      }
      if (fate === 'supersede') {
        removeCard(card.key);
      }
    });
};

// §10.8: the end of a running review with an answer settles the notes of its watchdog on the watched agent it
// reviewed, while the feed still holds the rows of its batch. Returns the held notes it superseded, oldest first.
export const settleReview = (agentId: string | undefined): readonly HeldNote[] => {
  const running = runningReview(agentId);
  if (running === undefined) {
    return [];
  }
  const { slot, watchdog } = running;
  const review = { agentId: running.agentId, slug: watchdog.slug, subagentId: slot.subagent, batchEnd: slot.batchEnd };
  const feed = watchedFeed(review.subagentId);
  const turn = (feed === undefined ? undefined : batchTurn(feed, review.batchEnd)) ?? currentTurn();
  const { keys, superseded } = settleHeld(review, turn);
  settleCards(review, turn, keys);
  return superseded;
};
