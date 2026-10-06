import { COMMAND } from '../command/spec';
import { errorText } from '../errors';
import { NOTE_TOOL } from '../note/tool';
import { envSwitch, settingsUnreadWarning } from './headless';
import { setMode } from './mode';
import { addOnWarning, notePrompt, setEnvOn } from './on-order';
import { isSupportedVersion } from './version';
import type { OnEvents } from '../on';
import type { EnvSwitch } from './headless';
import type { EngineInterface, Hook } from 'claude-code';

// §8.3: the note tool exists from the next prompt on, so it registers before any spawn. `/watchdog on`
// registers it again and blocks the watchdogs on a refusal, so a refusal here waits for that.
const registerNoteTool = async ($: EngineInterface): Promise<void> => {
  await $.tool.register(NOTE_TOOL).catch(() => undefined);
};

// §5.1: the call throws for a name that another plugin has; one row tells the person.
const registerCommand = async ($: EngineInterface): Promise<void> => {
  try {
    await $.command.register(COMMAND);
  } catch (error) {
    $.ui.log(`/watchdog is not registered: ${errorText(error)}`);
  }
};

// §5.3: the project and local settings must not turn a headless run on (ADR 0001); a read that fails keeps
// the session off too.
const projectSwitch = async ($: EngineInterface, value: string): Promise<EnvSwitch> =>
  Promise.all([$.settings.read({ source: 'project' }), $.settings.read({ source: 'local' })]).then(
    ([project, local]) => envSwitch(value, { project, local }),
    (error: unknown) => ({ isOn: false, warning: settingsUnreadWarning(errorText(error)) })
  );

// §5.3: every session reads `CLAUDE_WATCHDOG` and unsets it, so no Bash child and no nested `claude -p` gets
// it. Only a headless session uses the value; the on order (`command/install.ts`) applies it.
const takeEnvSwitch = async ($: EngineInterface, isUsed: boolean): Promise<void> => {
  const value = await $.env.get('CLAUDE_WATCHDOG').catch(() => undefined);
  if (value === undefined) {
    return;
  }
  await $.env.set('CLAUDE_WATCHDOG', undefined).catch(() => undefined);
  if (!isUsed || value === '') {
    return;
  }
  const { isOn, warning } = await projectSwitch($, value);
  setEnvOn(isOn);
  if (warning !== undefined) {
    addOnWarning(warning);
  }
};

// §5.1: the version gate first, the command last. In `unsupported` no note tool registers.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const { base } = await $.session.version();
  const isSupported = isSupportedVersion(base);
  setMode(isSupported ? 'off' : 'unsupported');
  await takeEnvSwitch($, isSupported && !e.isInteractive);
  if (isSupported) {
    await registerNoteTool($);
  }
  await registerCommand($);
  return next(e);
};

// §5.3: a Desktop attach counts only before the first prompt.
const onPromptSubmit: Hook<'prompt.submit'> = async (_$, e, next) => {
  notePrompt();
  return next(e);
};

export const installLifecycle = (on: OnEvents<'session.start' | 'prompt.submit'>): void => {
  on('session.start', onSessionStart);
  on('prompt.submit', { text: /^/u }, onPromptSubmit);
};
