import type { SessionAppendInput } from 'claude-code';

// §10: the origin kinds of a person prompt (`PromptOrigin`, d.ts 8554-8669). Every other kind is not one: a
// task notification, a plugin, a peer, a schedule, an unstamped channel. The aside (§10.2), the nudge budget
// reset (§10.4), the halt and `limited` retry (§12.3), the card clear (§13.1) and the recap's person rows
// (§7.6, §7.7) use this set.
export const PERSON_PROMPT_ORIGINS: Readonly<Record<string, true>> = {
  composer: true,
  bridge: true,
  sdk: true,
  'slack-ping': true,
};

// A `prompt.submit` origin or a session row's origin (a `PromptOrigin` or wider). The kit stamps no origin on
// a test's prompt (§16.2), so an absent one is not a person prompt.
export const isPersonPrompt = (origin: SessionAppendInput['origin'] | undefined): boolean =>
  origin !== undefined && PERSON_PROMPT_ORIGINS[origin.kind] === true;
