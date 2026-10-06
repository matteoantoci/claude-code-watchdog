import { removeCard } from '../band/cards';
import { replaceHeldNote } from './notes';
import type { HeldNote } from './notes';

// §9.4, §11.4: the one drop path of a held note that goes undelivered (displaced by a newer note, or a late
// repeat on a subagent): it leaves the held list and the band.
export const dropHeldNote = (note: HeldNote): void => {
  replaceHeldNote(note);
  removeCard(note);
};
