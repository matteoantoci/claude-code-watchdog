import { COMMAND } from '../command/spec';
import { setMode } from './mode';
import { isSupportedVersion } from './version';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// §5.1: the call throws for a name that another plugin has; one row tells the person.
const registerCommand = async ($: EngineInterface): Promise<void> => {
  try {
    await $.command.register(COMMAND);
  } catch (error) {
    $.ui.log(`/watchdog is not registered: ${errorText(error)}`);
  }
};

// §5.1: the version gate first, the command last.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const { base } = await $.session.version();
  setMode(isSupportedVersion(base) ? 'off' : 'unsupported');
  await registerCommand($);
  return next(e);
};

export const installLifecycle = (on: OnEvents<'session.start'>): void => {
  on('session.start', onSessionStart);
};
