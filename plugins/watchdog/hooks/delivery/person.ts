import type { PromptOrigin } from 'claude-code';

// §10: the `prompt.submit` origins of a person prompt. Every other kind is not one: a task notification, a
// plugin, a peer, a schedule, an unstamped channel. The aside (§10.2), the nudge budget reset (§10.4), the halt
// and `limited` retry (§12.3) and the card clear (§13.1) use this set.
export const PERSON_PROMPT_ORIGINS: readonly PromptOrigin['kind'][] = ['composer', 'bridge', 'sdk', 'slack-ping'];

// The kit stamps no origin on a test's prompt (§16.2), so an absent one is not a person prompt.
export const isPersonPrompt = (origin: PromptOrigin | undefined): boolean =>
  origin !== undefined && PERSON_PROMPT_ORIGINS.includes(origin.kind);
