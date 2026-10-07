import { isSeverity } from '../note/tool';
import { NO_COST } from '../prices';
import type { ReviewRecord } from '../log/log';
import type { Cost } from '../prices';
import type { PluginState } from 'claude-code';

// §13.3, §15: the cost ledger (its shape is the `ledger` key of the state contract): the tally of each watchdog
// slug and of the session, and the review count of each subagent type (§11.4).
export type Ledger = PluginState['watchdog']['ledger'];

export type Tally = Ledger['session'];

export const EMPTY_TALLY: Tally = {
  reviews: 0,
  notes: { blocker: 0, concern: 0, nit: 0 },
  tokens: 0,
  cost: NO_COST,
  model: null,
};

export const EMPTY_LEDGER: Ledger = { watchdogs: {}, session: EMPTY_TALLY, subagents: {} };

// §13.3: the notes column counts admitted notes. A review's trace also marks a note that left the held list
// (`displaced`, `discarded`) and one that never passed (`dropped:…`).
const ADMITTED: Readonly<Record<string, true>> = {
  steered: true,
  'aside on next prompt': true,
  'nudge pending': true,
  nudged: true,
  held: true,
};

const addNote = (notes: Tally['notes'], note: ReviewRecord['notes'][number]): Tally['notes'] =>
  isSeverity(note.severity) && Object.hasOwn(ADMITTED, note.delivery)
    ? { ...notes, [note.severity]: notes[note.severity] + 1 }
    : notes;

// §15: a failed review has no usage, so it adds a review and its notes only. A stopped review keeps its usage.
export const addReview = (tally: Tally, record: ReviewRecord): Tally => {
  const { usage } = record;
  const counted = { ...tally, reviews: tally.reviews + 1, notes: record.notes.reduce(addNote, tally.notes) };
  if (usage === null) {
    return counted;
  }
  const tokens =
    usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const cost: Cost =
    record.cost === null
      ? { ...tally.cost, hasUnpriced: true }
      : { ...tally.cost, usd: tally.cost.usd + record.cost, hasPrice: true };
  return { ...counted, tokens: tally.tokens + tokens, cost, model: usage.model };
};

// A value of a JSON record by an own key only: a slug or a subagent type is free text.
const ownOf = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// §11.4, §15: one finished review counts in its watchdog's tally, in the session's, and, for a review of a
// subagent, in its type's count.
export const addToLedger = (ledger: Ledger, slug: string, record: ReviewRecord): Ledger => {
  const type = record.subagent?.type;
  return {
    watchdogs: { ...ledger.watchdogs, [slug]: addReview(ownOf(ledger.watchdogs, slug) ?? EMPTY_TALLY, record) },
    session: addReview(ledger.session, record),
    subagents:
      type === undefined ? ledger.subagents : { ...ledger.subagents, [type]: (ownOf(ledger.subagents, type) ?? 0) + 1 },
  };
};

// The live ledger is module memory; `$.state` key `ledger` keeps a copy, which a reload restores (§14.6) and a
// session change carries over (§15: the reviews a session change stops count too).
const memory: { ledger: Ledger } = { ledger: EMPTY_LEDGER };

export const currentLedger = (): Ledger => memory.ledger;

export const tallyOf = (slug: string): Tally => ownOf(memory.ledger.watchdogs, slug) ?? EMPTY_TALLY;

export const sessionTally = (): Tally => memory.ledger.session;

export const tallyReview = (slug: string, record: ReviewRecord): void => {
  memory.ledger = addToLedger(memory.ledger, slug, record);
};

// §14.6: at load the ledger of before the reload comes back from `$.state`.
export const restoreLedger = (ledger: Ledger): void => {
  memory.ledger = ledger;
};
