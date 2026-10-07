import { cardKey, removeCard } from '../band/cards';
import { replaceHeldNote } from './notes';
import type { HeldNote } from './notes';

// §9.4, §11.4, §10.8: the one drop path of a held note that goes undelivered (displaced by a newer note, a late
// repeat on a subagent, or superseded by a later review): it leaves the held list and the band.
export const dropHeldNote = (note: HeldNote): void => {
  replaceHeldNote(note);
  removeCard(cardKey(note));
};
