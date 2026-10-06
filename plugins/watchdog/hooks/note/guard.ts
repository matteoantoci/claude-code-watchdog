import { severityRank } from './tool';
import type { Severity } from './tool';

// §9.5, build-session choice "Destructive-command check": why a note is dropped. Its delivery state is
// `dropped:<reason>`.
export type DropReason = 'unsafe' | 'empty' | 'noise' | 'duplicate' | 'rate-limit';

// §9.5 and build-session choice "Destructive-command check": the `result` text of each drop.
export const DROP_ACKS: Readonly<Record<DropReason, string>> = {
  unsafe: 'Dropped: unsafe note.',
  empty: 'Dropped: empty note.',
  noise: 'Dropped: nothing actionable.',
  duplicate: 'Dropped: already raised.',
  'rate-limit': "Dropped: this review's note budget is spent.",
};

// §9.2: omp `emission-guard.ts:33-39`.
export const normalizeNote = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// §9.3: the 37 omp phrases (`emission-guard.ts:52-94`) and the 2 watchdog forms, each normalized.
const NOISE: Readonly<Record<string, true>> = {
  stop: true,
  'stop here': true,
  'stop now': true,
  halt: true,
  abort: true,
  done: true,
  'task done': true,
  'task complete': true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  'ok done': true,
  'no issue': true,
  'no issues': true,
  'no issue continue': true,
  'no concerns': true,
  'no concern': true,
  'nothing to add': true,
  'nothing to flag': true,
  'nothing to report': true,
  'no notes': true,
  'no further input': true,
  'no further input needed': true,
  'no further input required': true,
  'no further watcher input': true,
  'no further watcher input needed': true,
  'no further advice': true,
  'no further advice needed': true,
  lgtm: true,
  'looks good': true,
  'all good': true,
  'agent is on track': true,
  'agent on track': true,
  'on track': true,
  continue: true,
  'carry on': true,
  'no further watchdog input': true,
  'no further watchdog input needed': true,
};

// §9.4: one admitted note of a review that is not a blocker, keyed by its normalized text.
export type NoteSlot = { readonly key: string; readonly severity: Severity };

// What the guard of one watchdog knows when a note arrives.
export type GuardView = {
  // §9.2: the highest severity this watchdog sent the key at, from the note history.
  readonly seen: Severity | undefined;
  // §9.4: the slots of the review that sends the note.
  readonly slots: readonly NoteSlot[];
  // §9.4: `maxNotesPerReview`.
  readonly budget: number;
  // §9.1: the severity of this watchdog's queued entry of a key, while it waits for delivery.
  readonly pendingSeverity: (key: string) => Severity | undefined;
};

// `raised`: the queued entry of the key takes the new severity in place. `admitted`: a new entry; a
// `displaced` key names the queued note of this review that leaves for it.
export type Verdict =
  | { readonly kind: 'dropped'; readonly reason: DropReason }
  | { readonly kind: 'raised'; readonly slots: readonly NoteSlot[] }
  | { readonly kind: 'admitted'; readonly slots: readonly NoteSlot[]; readonly displaced?: string };

const dropped = (reason: DropReason): Verdict => ({ kind: 'dropped', reason });

const isAbove = (severity: Severity, other: Severity | undefined): boolean =>
  other === undefined || severityRank(severity) > severityRank(other);

// §9.4: a blocker takes no slot, so a raise to blocker frees the key's slot; any other raise lifts it.
const raiseSlot = (slots: readonly NoteSlot[], note: NoteSlot): readonly NoteSlot[] =>
  note.severity === 'blocker'
    ? slots.filter((slot) => slot.key !== note.key)
    : slots.map((slot) => (slot.key === note.key ? note : slot));

// §9.4: the lowest slot of the review whose note waits for delivery; the first of equals.
const lowestPending = (view: GuardView): NoteSlot | undefined =>
  view.slots
    .filter((slot) => view.pendingSeverity(slot.key) !== undefined)
    .reduce<NoteSlot | undefined>(
      (low, slot) => (low === undefined || isAbove(low.severity, slot.severity) ? slot : low),
      undefined
    );

// §9.4: a full budget lets a higher note displace the lowest undelivered one, else `rate-limit`.
const displace = (note: NoteSlot, view: GuardView): Verdict => {
  const low = lowestPending(view);
  if (low === undefined || !isAbove(note.severity, low.severity)) {
    return dropped('rate-limit');
  }
  return { kind: 'admitted', slots: view.slots.map((slot) => (slot === low ? note : slot)), displaced: low.key };
};

// §9.4: omp `emission-guard.ts:290-319`. A key that already holds a slot of this review (it was delivered)
// keeps that one slot.
const charge = (note: NoteSlot, view: GuardView): Verdict => {
  if (note.severity === 'blocker' || view.slots.some((slot) => slot.key === note.key)) {
    return { kind: 'admitted', slots: raiseSlot(view.slots, note) };
  }
  if (view.slots.length < view.budget) {
    return { kind: 'admitted', slots: [...view.slots, note] };
  }
  return displace(note, view);
};

// §9.2: `empty`, `noise`, `duplicate`, then the budget. §9.1: a higher repeat of a queued key raises that
// entry and takes no new slot.
export const judgeNote = (note: NoteSlot, view: GuardView): Verdict => {
  if (note.key === '') {
    return dropped('empty');
  }
  if (Object.hasOwn(NOISE, note.key)) {
    return dropped('noise');
  }
  const pending = view.pendingSeverity(note.key);
  if (!isAbove(note.severity, view.seen) || (pending !== undefined && !isAbove(note.severity, pending))) {
    return dropped('duplicate');
  }
  return pending === undefined ? charge(note, view) : { kind: 'raised', slots: raiseSlot(view.slots, note) };
};

// §9.4: the slots of each watchdog's current review (watchdog slug → its review agent and slots). A note of
// a new review agent starts that review's budget.
const reviews = new Map<string, { readonly agentId: string; readonly slots: readonly NoteSlot[] }>();

export const reviewSlots = (watchdog: string, agentId: string): readonly NoteSlot[] => {
  const review = reviews.get(watchdog);
  return review?.agentId === agentId ? review.slots : [];
};

export const setReviewSlots = (watchdog: string, agentId: string, slots: readonly NoteSlot[]): void => {
  reviews.set(watchdog, { agentId, slots });
};
