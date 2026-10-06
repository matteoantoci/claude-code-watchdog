import { NO_COST } from '../prices';
import type { ReviewRecord } from '../log/log';
import type { Severity } from '../note/tool';
import type { Cost } from '../prices';

// §13.3, §15: what the finished reviews of one watchdog, or of the session, add up to: reviews, admitted notes
// by severity, tokens of all four classes, cost, and the model that ran last (null before any usage).
export type Tally = {
  readonly reviews: number;
  readonly notes: Readonly<Record<Severity, number>>;
  readonly tokens: number;
  readonly cost: Cost;
  readonly model: string | null;
};

export const EMPTY_TALLY: Tally = {
  reviews: 0,
  notes: { blocker: 0, concern: 0, nit: 0 },
  tokens: 0,
  cost: NO_COST,
  model: null,
};

const addNote = (notes: Tally['notes'], severity: string): Tally['notes'] =>
  severity === 'blocker' || severity === 'concern' || severity === 'nit'
    ? { ...notes, [severity]: notes[severity] + 1 }
    : notes;

// §15: a failed review has no usage, so it adds a review and its notes only. A stopped review keeps its usage.
export const addReview = (tally: Tally, record: ReviewRecord): Tally => {
  const { usage } = record;
  const counted = {
    ...tally,
    reviews: tally.reviews + 1,
    notes: record.notes.reduce((notes, note) => addNote(notes, note.severity), tally.notes),
  };
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

// Module memory: the tally of each watchdog slug and of the session. A reload starts them again.
const tallies = new Map<string, Tally>();
const memory: { session: Tally } = { session: EMPTY_TALLY };

export const tallyOf = (slug: string): Tally => tallies.get(slug) ?? EMPTY_TALLY;

export const sessionTally = (): Tally => memory.session;

// §11.4, §15: each finished review counts, a subagent review too.
export const tallyReview = (slug: string, record: ReviewRecord): void => {
  tallies.set(slug, addReview(tallyOf(slug), record));
  memory.session = addReview(memory.session, record);
};
