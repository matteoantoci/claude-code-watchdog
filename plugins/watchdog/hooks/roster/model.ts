import type { ModelEffort, TurnStepInput } from 'claude-code';

export type EffortSetting = ModelEffort | 'auto';

// §6.2: the effort levels of 2.1.290, plus `auto` for the session effort at review start.
const LEVELS: Readonly<Record<EffortSetting, true>> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

// What the main loop's `turn.step` names as its effort: a level or a budget, absent for a model without one.
export type SessionEffort = TurnStepInput['effort'];

export const isEffortSetting = (value: unknown): value is EffortSetting =>
  typeof value === 'string' && Object.hasOwn(LEVELS, value);

export type ModelSetting =
  | { readonly kind: 'model'; readonly model: string; readonly level: EffortSetting | undefined }
  | { readonly kind: 'inherit' }
  | { readonly kind: 'no_model'; readonly reason: string };

// §6.2: the omp string `<provider>/<id>[:level]`.
const MODEL_PATTERN = /^(?:(?<provider>[^/]*)\/)?(?<id>[^:]*)(?::(?<level>.*))?$/u;

// §6.2: only the provider `anthropic`, or none, works now; the model id goes to the agent spec unchanged.
export const parseModel = (text: string): ModelSetting => {
  const { provider, id = '', level } = MODEL_PATTERN.exec(text)?.groups ?? {};
  if (provider !== undefined && provider !== 'anthropic') {
    return { kind: 'no_model', reason: `provider "${provider}" is not supported; only anthropic works now` };
  }
  if (id === 'inherit') {
    return { kind: 'inherit' };
  }
  if (id === '') {
    return { kind: 'no_model', reason: `no model id in "${text}"` };
  }
  if (level !== undefined && !isEffortSetting(level)) {
    return { kind: 'no_model', reason: `unknown effort level "${level}"` };
  }
  return { kind: 'model', model: id, level };
};

// §6.2: the 4 names that the spawn accepts are aliases; each other id is a full id.
const ALIASES: Readonly<Record<string, true>> = { sonnet: true, opus: true, haiku: true, fable: true };

export const isAlias = (model: string): boolean => Object.hasOwn(ALIASES, model);

// §6.2: `auto` takes the session effort at review start, else `medium`.
export const resolveEffort = (setting: EffortSetting, session: SessionEffort): ModelEffort | number =>
  setting === 'auto' ? (session ?? 'medium') : setting;

// The session effort as the last main-loop `turn.step` named it, in module memory.
const memory: { effort: SessionEffort } = { effort: undefined };

export const sessionEffort = (): SessionEffort => memory.effort;

export const setSessionEffort = (effort: SessionEffort): void => {
  memory.effort = effort;
};
