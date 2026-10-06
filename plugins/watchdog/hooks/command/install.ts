import { currentMode } from '../lifecycle/mode';
import { parseSubcommand } from './args';
import { UNSUPPORTED_REPLY, USAGE_REPLY } from './spec';
import { statusText } from './status';
import type { Hook, On } from 'claude-code';

const headline = (): string =>
  currentMode() === 'unsupported' ? `watchdog unsupported: ${UNSUPPORTED_REPLY}` : `watchdog ${currentMode()}`;

const onWatchdogCommand: Hook<'command.run'> = async (_$, e, next) => {
  const subcommand = parseSubcommand(e.args);
  if (subcommand === 'status') {
    return { text: statusText(headline()) };
  }
  if (subcommand === 'unknown') {
    return { text: USAGE_REPLY };
  }
  if (subcommand === 'on' && currentMode() === 'unsupported') {
    return { text: UNSUPPORTED_REPLY };
  }
  return next(e);
};

export const installCommand = (on: On): void => {
  on('command.run', { command: 'watchdog' }, onWatchdogCommand);
};
