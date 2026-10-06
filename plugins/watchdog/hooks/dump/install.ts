import { watchdogBySlug } from '../agents/roster';
import { parseSubcommand } from '../command/args';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { errorText } from '../errors';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession, onWarnings } from '../lifecycle/on-order';
import { addLogRecord, currentLog, recentPrompts, unreviewedRecord } from '../log/log';
import { heldNotes, logRow } from '../note/notes';
import { waitingUpdates } from '../review/backlog';
import { watchedFeeds } from '../review/backlogs';
import { slotOf } from '../review/slots';
import { configDir, dumpPath, dumpText } from './dump';
import { addDumpLines, dumpLines } from './sections';
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
// under `<config>/watchdog/dumps/`. Returns its path and text; undefined when no `<config>` is known.
const writeDumpFile = async (
  $: EngineInterface,
  sessionId: string,
  isRaw: boolean
): Promise<{ path: string; text: string } | undefined> => {
  const config = configDir(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'));
  if (config === undefined) {
    return undefined;
  }
  const time = await $.clock.now();
  const text = dumpText({
    sessionId,
    time,
    lines: dumpLines(),
    records: currentLog(),
    ...(isRaw ? { prompts: recentPrompts() } : {}),
  });
  const path = dumpPath(config, sessionId, time);
  await $.fs.write(path, text);
  return { path, text };
};

// §13.4: `/watchdog dump`: the file, and on the terminal the clipboard. Returns the reply.
const writeDump = async ($: EngineInterface, isRaw: boolean): Promise<string> => {
  const dump = await writeDumpFile($, await $.session.id(), isRaw);
  if (dump === undefined) {
    return 'watchdog dump failed: neither CLAUDE_CONFIG_DIR nor HOME is set';
  }
  await copyDump($, dump.text);
  return `watchdog dump: ${dump.path}`;
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

// §7.5, §11.2: one `unreviewed: N updates` record for each backlog that no review took, the primary agent's and
// each watched subagent's: the updates after the cursor, or after the batch of the review that runs on it.
const recordUnreviewed = async ($: EngineInterface): Promise<void> => {
  const time = await $.clock.now();
  const records = watchedFeeds().flatMap(({ subagent, feed }) =>
    Object.entries(feed.cursors).flatMap(([slug, cursor]) => {
      const slot = slotOf(slug);
      const isTaken = slot.state === 'reviewing' && slot.subagent === subagent?.agentId;
      const updates = waitingUpdates(feed, isTaken ? slot.batchEnd : cursor);
      const watchdog = watchdogBySlug(slug)?.name ?? slug;
      return updates === 0 ? [] : [unreviewedRecord({ watchdog, time, updates })];
    })
  );
  for (const record of records) {
    addLogRecord(record);
  }
};

// §10.6: at the end of a headless session, the dump file holds the notes that still wait, the `unreviewed`
// records and the warnings. A session that never turned on and has no warning leaves no file.
const onSessionEnd: Hook<'session.end'> = async ($, e, next) => {
  if (!isInteractiveSession() && (currentMode() === 'on' || onWarnings().length > 0)) {
    await recordUnreviewed($).catch(() => undefined);
    await writeDumpFile($, e.sessionId, false).catch(() => undefined);
  }
  return next(e);
};

export const installDump = (on: OnEvents<'command.run' | 'session.end'>): void => {
  on('command.run', { command: 'watchdog' }, onDumpCommand);
  on('session.end', onSessionEnd);
  // §10.6, §13.4: the notes that still wait, as their log row shows them.
  addDumpLines(() =>
    heldNotes().map((note) => `waiting: ${logRow(note, watchdogBySlug(note.watchdog)?.name ?? note.watchdog)}`)
  );
};
