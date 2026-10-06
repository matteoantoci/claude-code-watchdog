import { setConfigChanged, watchedFiles } from '../agents/roster';
import { parseSubcommand } from '../command/args';
import { currentMode } from '../lifecycle/mode';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §4.5: "config changed" when a file time differs from the time of the last read; a missing file has none.
const checkConfig = async ($: EngineInterface): Promise<void> => {
  const now = await Promise.all(
    watchedFiles().map(async ({ path }) => ({
      path,
      mtimeMs: await $.fs.stat(path).then(
        (stat) => stat.mtimeMs,
        () => null
      ),
    }))
  );
  setConfigChanged(now);
};

// §4.5, §13.3: the file times are checked before the command hook beneath draws the status. The status shows
// the roster only while on.
const onStatusCommand: Hook<'command.run'> = async ($, e, next) => {
  if (parseSubcommand(e.args) === 'status' && currentMode() === 'on') {
    await checkConfig($);
  }
  return next(e);
};

// Install before the command area, so that this hook sits above its `command.run` hook.
export const installRoster = (on: OnEvents<'command.run'>): void => {
  on('command.run', { command: 'watchdog' }, onStatusCommand);
};
