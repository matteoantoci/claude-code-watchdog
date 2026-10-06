// §5.1, §5.3, §5.4: where the on state comes from. Pure: the hooks read the sources and apply the flag.
import type { PluginOptions, PluginState } from 'claude-code';

export type OnFlag = PluginState['watchdog']['on'];

export type OnSource = Extract<OnFlag, { readonly isOn: true }>['source'];

// §5.1: what `session.start` (or a Desktop attach) found. `state` and `stored` are raw reads; `isEnvOn` is
// a `CLAUDE_WATCHDOG` that turns a headless session on (§5.3).
export type OnSources = {
  readonly state: unknown;
  readonly stored: unknown;
  readonly onByDefault: boolean;
  readonly isInteractive: boolean;
  readonly isEnvOn: boolean;
};

const SOURCES: readonly OnSource[] = ['/watchdog on', 'onByDefault', 'CLAUDE_WATCHDOG'];

// §5.3: the dump warning of a Desktop attach that drops an on state from `CLAUDE_WATCHDOG`.
export const DESKTOP_DROP_WARNING =
  'CLAUDE_WATCHDOG on state dropped at the Desktop attach: the session is interactive, so the stored flag and onByDefault apply';

// §14.2: the `$.store` key of the on flag of one session.
export const onStoreKey = (sessionId: string): string => `on:${sessionId}`;

// A `$.state` or `$.store` value as an on flag; undefined for no value or a value of another shape.
export const asOnFlag = (value: unknown): OnFlag | undefined => {
  if (typeof value !== 'object' || value === null || !('isOn' in value)) {
    return undefined;
  }
  if (value.isOn === false) {
    return { isOn: false };
  }
  const source = 'source' in value ? SOURCES.find((known) => known === value.source) : undefined;
  return value.isOn === true && source !== undefined ? { isOn: true, source } : undefined;
};

// §5.3: an on state that `CLAUDE_WATCHDOG` gave.
export const isEnvOnFlag = (value: unknown): boolean => {
  const flag = asOnFlag(value);
  return flag?.isOn === true && flag.source === 'CLAUDE_WATCHDOG';
};

// §5.1: the first source that holds a value wins: the `$.state` flag, the stored `on:<sessionId>` flag,
// `onByDefault`. The last two only for an interactive session. §5.3: a headless session takes only
// `CLAUDE_WATCHDOG`; undefined leaves it as it is.
export const pickOnFlag = (sources: OnSources): OnFlag | undefined => {
  const state = asOnFlag(sources.state);
  if (state !== undefined) {
    return state;
  }
  if (!sources.isInteractive) {
    return sources.isEnvOn ? { isOn: true, source: 'CLAUDE_WATCHDOG' } : undefined;
  }
  const defaultFlag: OnFlag = sources.onByDefault ? { isOn: true, source: 'onByDefault' } : { isOn: false };
  return asOnFlag(sources.stored) ?? defaultFlag;
};

// §5.4: the on source while on, for `/watchdog status` and the dump.
const memory: { source: OnSource | undefined; warnings: string[] } = { source: undefined, warnings: [] };

export const currentOnSource = (): OnSource | undefined => memory.source;

export const setOnSource = (source: OnSource | undefined): void => {
  memory.source = source;
};

// §13.4: the on-state warnings of this process, for the dump.
export const onWarnings = (): readonly string[] => memory.warnings;

export const addOnWarning = (warning: string): void => {
  memory.warnings.push(warning);
};

// §5.3: a Desktop attach before the first prompt makes the session interactive; `CLAUDE_WATCHDOG` asked a
// headless session to turn on. §14.6: a reload on the desktop starts with `isInteractive` false, as the first
// start did, but finds the desktop among the surfaces already.
// §4.1: `onByDefault` from `register(on, options)`; a missing or non-boolean value is the default, false.
const session = { isInteractive: false, hasDesktop: false, hasPrompted: false, onByDefault: false, isEnvOn: false };

export const isEnvOn = (): boolean => session.isEnvOn;

export const setEnvOn = (isOn: boolean): void => {
  session.isEnvOn = isOn;
};

export const isOnByDefault = (): boolean => session.onByDefault;

export const setOnByDefault = (options: PluginOptions): void => {
  session.onByDefault = options.onByDefault === true;
};

export const isInteractiveSession = (): boolean => session.isInteractive || session.hasDesktop;

export const setInteractiveSession = (isInteractive: boolean): void => {
  session.isInteractive = isInteractive;
};

export const setSurfacesAtStart = (surfaces: readonly string[]): void => {
  session.hasDesktop = surfaces.includes('desktop');
};

export const hasPrompted = (): boolean => session.hasPrompted;

export const notePrompt = (): void => {
  session.hasPrompted = true;
};
