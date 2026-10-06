import { COMMAND } from '../command/spec';
import { errorText } from '../errors';
import { NOTE_TOOL } from '../note/tool';
import { setMode } from './mode';
import { notePrompt } from './on-order';
import { isSupportedVersion } from './version';
import type { OnEvents } from '../on';
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

// §5.1: the version gate first, the command last. In `unsupported` no note tool registers.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const { base } = await $.session.version();
  const isSupported = isSupportedVersion(base);
  setMode(isSupported ? 'off' : 'unsupported');
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
