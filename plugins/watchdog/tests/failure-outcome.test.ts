import { describe, expect, test } from 'claude-code/testing';
import { reviewOutcome } from '../hooks/failure/classify';
import type { TurnCompleteInput } from 'claude-code';

const usage = (model: string) => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model,
});

// A review agent's `turn.complete`; an error has no `usage` (spec §12.1).
const ended = (reason: 'answer' | 'aborted' | 'error', model = 'claude-opus-4-5'): TurnCompleteInput => ({
  turnId: 'r1',
  agentId: 'afake0001',
  reason,
  answer: '',
  durationMs: 5,
  isAborted: reason === 'aborted',
  ...(reason === 'error' ? {} : { usage: usage(model) }),
});

const REFUSED: TurnCompleteInput = {
  ...ended('answer'),
  reason: 'refusal',
  refusal: { category: 'cyber', explanation: null },
};

type Facts = { error?: string; steps?: number; isCompact?: boolean; ran?: string };

// A review of the default watchdog (`opus`), with the facts the mod saw of it. The model that ran is
// `usage.model`, else the spawn's.
const review = (end: TurnCompleteInput, facts: Facts = {}) =>
  reviewOutcome({
    end,
    errorText: facts.error,
    steps: facts.steps ?? 1,
    isCompact: facts.isCompact ?? false,
    model: 'opus',
    ran: end.usage?.model ?? facts.ran,
  });

describe('§12.3 the outcome of a finished review', () => {
  test('an answer is a success, also the empty answer of a maxTurns end', () => {
    expect(review(ended('answer'), { steps: 12 })).toEqual({ kind: 'answered', error: null });
  });

  test('a refusal and a person stop count no failure', () => {
    expect(review(REFUSED)).toEqual({ kind: 'refused', error: null });
    expect(review(ended('aborted'))).toEqual({ kind: 'stopped', error: null });
  });

  test('an error takes its class from the synthetic row text', () => {
    expect(review(ended('error'), { error: 'API Error: 529 Overloaded.' })).toEqual({
      kind: 'failed',
      error: 'API Error: 529 Overloaded.',
    });
    expect(review(ended('error'), { error: 'Credit balance is too low' }).kind).toBe('halt');
    expect(review(ended('error'), { error: "You've hit your limit · resets 3pm" }).kind).toBe('limited');
    expect(review(ended('error'), { error: "There's an issue with the selected model (x)." }).kind).toBe('no_model');
  });

  test('an error with no row text is one plain failure that says so', () => {
    expect(review(ended('error'))).toEqual({ kind: 'failed', error: 'the review failed with no error text' });
  });

  test('a prompt too large at step 0 retries once, then drops; at a later step it keeps the notes', () => {
    const tooLong = 'Prompt is too long · the request is ~375704 tokens (limit 200000)';
    expect(review(ended('error'), { error: tooLong, steps: 1 }).kind).toBe('retry');
    expect(review(ended('error'), { error: tooLong, steps: 1, isCompact: true }).kind).toBe('dropped');
    expect(review(ended('error'), { error: tooLong, steps: 3 })).toEqual({ kind: 'kept', error: tooLong });
  });

  test('a model that the roster alias does not match gives no_model', () => {
    expect(review(ended('answer', 'claude-sonnet-5-5'))).toEqual({
      kind: 'no_model',
      error: 'availableModels gave claude-sonnet-5-5',
    });
    expect(review(ended('aborted', 'claude-haiku-4-5')).kind).toBe('no_model');
  });

  test('the spawn model counts when the end has no usage; `inherit` names no model', () => {
    expect(review(ended('error'), { error: 'API Error: 529 Overloaded.', ran: 'claude-sonnet-5-5' })).toEqual({
      kind: 'no_model',
      error: 'availableModels gave claude-sonnet-5-5',
    });
    expect(review({ ...REFUSED, usage: usage('inherit') }).kind).toBe('refused');
  });
});
