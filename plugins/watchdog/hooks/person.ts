// §10: the origin kinds of a person prompt (`PromptOrigin`, d.ts 8554-8669). Each other kind (`channel`,
// `task-notification`, `plugin`, …) is not one.
export const PERSON_PROMPT_ORIGINS: Readonly<Record<string, true>> = {
  composer: true,
  bridge: true,
  sdk: true,
  'slack-ping': true,
};

export const isPersonOrigin = (origin: { readonly kind: string }): boolean =>
  PERSON_PROMPT_ORIGINS[origin.kind] === true;
