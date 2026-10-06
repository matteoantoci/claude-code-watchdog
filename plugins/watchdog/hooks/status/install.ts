import { currentRoster } from '../agents/roster';
import { parseSubcommand } from '../command/args';
import { statusHeadline, statusSections } from '../command/status';
import { configDir } from '../dump/dump';
import { healthParts } from '../failure/state';
import { currentMode } from '../lifecycle/mode';
import { slotOf } from '../review/slots';
import { displayPath } from '../roster/paths';
import { drawStatus } from './draw';
import { sessionTally, tallyOf } from './ledger';
import { queueSnapshot, replyOf, snapshotFor } from './snapshots';
import { statusTable } from './table';
import type { OnEvents } from '../on';
import type { TableElements } from './draw';
import type { StatusTable } from './table';
import type { ButtonProps, ElementConstructor, EngineInterface, Hook, RenderElement } from 'claude-code';

// §5.1, §13.3: a bare `/watchdog` and `/watchdog status`.
const STATUS_ARGS = /^\s*(?:status)?\s*$/iu;

// §13.4: the reply of a written dump.
const DUMP_REPLY = /^watchdog dump: (?<path>\S.*)$/u;

// §4.3, §13.3: how the status names the user file `<config>/WATCHDOG.json`; undefined when no `<config>` is known.
const userFileName = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await $.env.get('HOME');
  const claudeConfigDir = await $.env.get('CLAUDE_CONFIG_DIR');
  const config = configDir(claudeConfigDir, home);
  if (config === undefined) {
    return undefined;
  }
  const cwd = await $.session.cwd();
  return displayPath(`${config}/WATCHDOG.json`, { configDir: claudeConfigDir, home, gitRoot: null, cwd, root: cwd });
};

// §13.3: what the table shows when the command runs. Only the default watchdog's row reads the user file name.
const snapshotOf = async ($: EngineInterface, text: string): Promise<StatusTable> => {
  const watchdogs = currentMode() === 'on' ? currentRoster() : [];
  const configFile = watchdogs.some((watchdog) => watchdog.source === null)
    ? await userFileName($).catch(() => undefined)
    : undefined;
  return statusTable({
    text,
    sections: statusSections(statusHeadline()),
    watchdogs: watchdogs.map((watchdog) => ({
      watchdog,
      slot: slotOf(watchdog.slug),
      parts: healthParts(watchdog.slug),
      tally: tallyOf(watchdog.slug),
    })),
    session: sessionTally(),
    configFile,
  });
};

// §13.3: the command hook beneath answers the status; this hook keeps the snapshot of that answer.
const onStatusCommand: Hook<'command.run'> = async ($, e, next) => {
  const result = await next(e);
  if (result.text !== undefined) {
    queueSnapshot(await snapshotOf($, result.text));
  }
  return result;
};

// §13.4: the dump path as text with a copy button, which copies the path on the surface it is pressed on.
const drawDump = (
  $: EngineInterface,
  E: TableElements & { readonly Button: ElementConstructor<ButtonProps> },
  path: string
): RenderElement =>
  E.Box({
    key: 'watchdog-dump',
    flexDirection: 'row',
    columnGap: 1,
    children: [
      E.Text({ wrap: 'truncate-middle', children: `watchdog dump: ${path}` }),
      E.Button({
        key: 'copy-path',
        label: 'copy path',
        onPress: (press) => {
          $.ui.copy({ text: path, surface: press.surface }).catch(() => undefined);
        },
      }),
    ],
  });

export const installStatus = (on: OnEvents<'command.run' | 'ui.render'>): void => {
  on('command.run', { command: 'watchdog', args: STATUS_ARGS }, onStatusCommand);
  // §13.3, §13.4: the status table and the dump path; any other row, and a row of no known run, as the engine
  // draws it.
  on(
    'ui.render',
    { component: 'CommandOutput', props: { command: 'watchdog', isErrored: false } },
    async ($, e, next) => {
      const subcommand = parseSubcommand(e.props.args);
      const table = subcommand === 'status' ? snapshotFor(e.requestId, e.props.text) : undefined;
      if (table !== undefined) {
        return drawStatus($.ui.resolve(e), table, e.viewport?.columns);
      }
      const path =
        subcommand === 'dump' || subcommand === 'dump raw'
          ? DUMP_REPLY.exec(replyOf(e.props.text))?.groups?.path
          : undefined;
      return path === undefined ? next(e) : drawDump($, $.ui.resolve(e), path);
    }
  );
};
