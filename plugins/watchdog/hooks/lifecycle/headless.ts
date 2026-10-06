// §5.3: what `CLAUDE_WATCHDOG` does in a headless session. Pure: the session.start hook reads the variable
// and the settings sources, and applies the switch.
import type { Settings } from 'claude-code';

// The settings sources that must not turn a headless run on (ADR 0001).
export type ProjectSource = 'project' | 'local';

export type ProjectSettings = Readonly<Record<ProjectSource, Settings>>;

// `isOn` turns the session on with the source `CLAUDE_WATCHDOG`; `warning` goes to the dump.
export type EnvSwitch = { readonly isOn: boolean; readonly warning?: string };

const ON_VALUES: ReadonlySet<string> = new Set(['on', '1']);

const PROJECT_SOURCES: readonly ProjectSource[] = ['project', 'local'];

export const badValueWarning = (value: string): string =>
  `CLAUDE_WATCHDOG=${JSON.stringify(value)} is not on or 1, so the session stays off`;

export const settingsEnvWarning = (source: ProjectSource): string =>
  `CLAUDE_WATCHDOG is ignored, because the ${source} settings set it in env; set it in the shell or the user settings`;

export const settingsUnreadWarning = (problem: string): string =>
  `CLAUDE_WATCHDOG is ignored, because the project and local settings could not be read: ${problem}`;

const hasEnvSwitch = (settings: Settings): boolean => {
  const env = settings['env'];
  return typeof env === 'object' && env !== null && 'CLAUDE_WATCHDOG' in env;
};

// §5.3: an unset or empty variable does nothing. A project or local `env` value of it keeps the session off;
// else `on` and `1` turn it on, and each other value keeps it off. Each refusal gives one warning.
export const envSwitch = (value: string | undefined, settings: ProjectSettings): EnvSwitch => {
  if (value === undefined || value === '') {
    return { isOn: false };
  }
  const source = PROJECT_SOURCES.find((name) => hasEnvSwitch(settings[name]));
  if (source !== undefined) {
    return { isOn: false, warning: settingsEnvWarning(source) };
  }
  return ON_VALUES.has(value) ? { isOn: true } : { isOn: false, warning: badValueWarning(value) };
};
