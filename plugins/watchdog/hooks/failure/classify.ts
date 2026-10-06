import { isAlias } from '../roster/model';
import type { TurnCompleteInput } from 'claude-code';

// §12.2: the class of a failed review, from the text of the agent's synthetic `session.append` row.
export type ErrorClass = 'limit' | 'billing' | 'too_long' | 'no_model' | 'overload' | 'gateway' | 'other' | 'unmatched';

// §12.2: the text table, first match wins. The gateway 429 text holds the overload text, so it comes first;
// `limit` is the exact phrase, never the word alone.
const ERROR_TEXTS: readonly (readonly [ErrorClass, readonly string[]])[] = [
  ['limit', ["You've hit your limit"]],
  ['billing', ['Credit balance is too low']],
  ['too_long', ['Prompt is too long']],
  ['no_model', ["There's an issue with the selected model"]],
  ['gateway', ['API Error: Server is temporarily limiting requests (not your usage limit)']],
  [
    'overload',
    ['API Error: 529 Overloaded', 'Server is temporarily limiting requests', 'Repeated 529 Overloaded errors'],
  ],
  ['other', ['API Error: 400 ']],
];

export const classifyError = (text: string): ErrorClass =>
  ERROR_TEXTS.find(([, phrases]) => phrases.some((phrase) => text.includes(phrase)))?.[0] ?? 'unmatched';

// §12.2 spawn errors: a reject or a `{ deny }` of `$.agent.spawn`.
export type SpawnErrorClass = 'blocked' | 'capped' | 'failed';

// The reject of `permissions.deny: ["Agent"]`, and the deny of `["Agent(watchdog:<slug>)"]`.
const isPermissionDeny = (text: string): boolean =>
  text.includes('$.tool.call: no tool named "Agent" in this session') ||
  (text.startsWith("Agent type 'watchdog:") && text.includes('has been denied by permission rule'));

// The cap for each plugin rejects; the cap for the session resolves a deny.
const isCap = (text: string): boolean =>
  (text.includes('$.agent.spawn refused:') && text.includes('spawns are running at once')) ||
  text.startsWith('Concurrent subagent limit reached.');

export const classifySpawnError = (text: string): SpawnErrorClass => {
  if (isPermissionDeny(text)) {
    return 'blocked';
  }
  return isCap(text) ? 'capped' : 'failed';
};

// §12.2: an alias matches any model id that contains it; a full id matches only an equal id.
export const isSameModel = (roster: string, ran: string): boolean =>
  isAlias(roster) ? ran.includes(roster) : ran === roster;

// §12.3: what a finished review or a failed spawn does to its watchdog; `error` is the text for `last error`
// and the dump (§12.4). `kept` is a prompt too large at a later step; `halt` is billing; `dropped` is a
// prompt still too large after the retry at once.
export type Outcome = {
  readonly kind:
    | 'answered'
    | 'refused'
    | 'stopped'
    | 'kept'
    | 'retry'
    | 'failed'
    | 'halt'
    | 'dropped'
    | 'limited'
    | 'no_model'
    | 'blocked'
    | 'capped';
  readonly error: string | null;
};

// What the mod saw of one review: its end, the text of its last synthetic row, its `turn.step` count, whether
// it was the retry at once, its roster model and the model that ran (`usage.model`, else the spawn's).
export type ReviewEnd = {
  readonly end: TurnCompleteInput;
  readonly errorText?: string | undefined;
  readonly steps: number;
  readonly isCompact: boolean;
  readonly model: string;
  readonly ran: string | undefined;
};

// §12.1: each step counts at its start, so the step of the error is the count less one.
const tooLong = (review: ReviewEnd, error: string): Outcome => {
  if (review.steps > 1) {
    return { kind: 'kept', error };
  }
  return { kind: review.isCompact ? 'dropped' : 'retry', error };
};

const CLASS_OUTCOMES: Readonly<Record<ErrorClass, Outcome['kind']>> = {
  limit: 'limited',
  billing: 'halt',
  too_long: 'retry',
  no_model: 'no_model',
  overload: 'failed',
  gateway: 'failed',
  other: 'failed',
  unmatched: 'failed',
};

const errorOutcome = (review: ReviewEnd): Outcome => {
  const error = review.errorText ?? 'the review failed with no error text';
  const kind = classifyError(error);
  return kind === 'too_long' ? tooLong(review, error) : { kind: CLASS_OUTCOMES[kind], error };
};

const END_OUTCOMES = { answer: 'answered', refusal: 'refused', aborted: 'stopped' } as const;

// §12.2, §12.3: a model that does not match gives `no_model` first; `inherit` names no model.
export const reviewOutcome = (review: ReviewEnd): Outcome => {
  const { ran } = review;
  if (ran !== undefined && ran !== 'inherit' && !isSameModel(review.model, ran)) {
    return { kind: 'no_model', error: `availableModels gave ${ran}` };
  }
  return review.end.reason === 'error' ? errorOutcome(review) : { kind: END_OUTCOMES[review.end.reason], error: null };
};
