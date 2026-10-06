import { PREFLIGHT_MAX_TOKENS } from '../constants';
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code';

// §5.2 step 2: one 1-token call for each distinct model finds a model that cannot run before any review.
export const preflightRequest = (model: string): ModelCompleteRequest => ({
  model,
  prompt: 'Reply with one word.',
  maxTokens: PREFLIGHT_MAX_TOKENS,
});

// The engine rejects the call for a model it refuses (§6.2); of the API errors only `model_not_found` speaks
// about the model. Any other error is left to the reviews (§12).
export const preflightProblem = (result: ModelCompleteResult): string | undefined =>
  !result.isAnswered && result.reason === 'api-error' && result.error === 'model_not_found'
    ? 'the preflight call gave model_not_found'
    : undefined;
