import { parseSubcommand } from '../command/args';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { errorText } from '../errors';
import { currentLog, recentPrompts } from '../log/log';
import { configDir, dumpPath, dumpText } from './dump';
import { dumpLines } from './sections';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §13.2, §13.4: on the terminal the dump text goes to the clipboard too; the row of the outcome waits, so
// that it lands below the command echo. The desktop has no clipboard path, so it gets the file only.
const copyDump = async ($: EngineInterface, text: string): Promise<void> => {
  const surfaces = await $.session.surfaces();
  if (!surfaces.includes('terminal')) {
    return;
  }
  const row = await $.ui.copy({ text, surface: 'terminal' }).then(
    (copied) => (copied.isCopied ? 'dump copied to the clipboard' : `dump not copied: ${copied.reason}`),
    (error: unknown) => `dump not copied: ${errorText(error)}`
  );
  $.clock.after(COMMAND_LOG_DELAY_MS, () => {
    $.ui.log(row);
  });
};

// §13.4: the review log, the lines of the other areas and, for `dump raw`, the last prompts, in one file
// under `<config>/watchdog/dumps/`. Returns the reply.
const writeDump = async ($: EngineInterface, isRaw: boolean): Promise<string> => {
  const config = configDir(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'));
  if (config === undefined) {
    return 'watchdog dump failed: neither CLAUDE_CONFIG_DIR nor HOME is set';
  }
  const sessionId = await $.session.id();
  const time = await $.clock.now();
  const records = currentLog();
  const text = dumpText({
    sessionId,
    time,
    lines: dumpLines(),
    records,
    ...(isRaw ? { prompts: recentPrompts() } : {}),
  });
  const path = dumpPath(config, sessionId, time);
  await $.fs.write(path, text);
  await copyDump($, text);
  return `watchdog dump: ${path}`;
};

// §13.4: `/watchdog dump` and `/watchdog dump raw`; the command hook passes them here.
const onDumpCommand: Hook<'command.run'> = async ($, e, next) => {
  const subcommand = parseSubcommand(e.args);
  if (subcommand !== 'dump' && subcommand !== 'dump raw') {
    return next(e);
  }
  const reply = await writeDump($, subcommand === 'dump raw').catch(
    (error: unknown) => `watchdog dump failed: ${errorText(error)}`
  );
  return { text: reply };
};

export const installDump = (on: OnEvents<'command.run'>): void => {
  on('command.run', { command: 'watchdog' }, onDumpCommand);
};
