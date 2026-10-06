import { preflightProblem, preflightRequest } from '../agents/preflight';
import { setRegisteredSpec } from '../agents/registered';
import { setConfigChanged, setRoster, watchedFiles } from '../agents/roster';
import { agentSpec } from '../agents/spec';
import { systemPrompt } from '../agents/system-prompt';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { errorText } from '../errors';
import { EMPTY_FEED, currentFeed, setFeed, startFeed } from '../feed/feed';
import { currentMode, setMode } from '../lifecycle/mode';
import { clearHeldNotes } from '../note/notes';
import { NOTE_TOOL } from '../note/tool';
import { resetCadences } from '../review/cadence';
import { setSlot, slotAfterOn, slotOf } from '../review/slots';
import { buildRoster } from '../roster/merge';
import { sessionEffort } from '../roster/model';
import { searchPaths } from '../roster/paths';
import { parseSubcommand } from './args';
import { UNSUPPORTED_REPLY, USAGE_REPLY } from './spec';
import { statusText } from './status';
import type { Roster, WatchedFile, Watchdog } from '../agents/roster';
import type { OnEvents } from '../on';
import type { LoadedFile } from '../roster/merge';
import type { SearchPath, Where } from '../roster/paths';
import type { EngineInterface, Hook } from 'claude-code';

const headline = (): string =>
  currentMode() === 'unsupported' ? `watchdog unsupported: ${UNSUPPORTED_REPLY}` : `watchdog ${currentMode()}`;

// §5.2 step 4, §14.1: `$.state` keeps the on flag and the feed. The live copies are module memory, so a
// refused write loses only what a reload would carry over.
const saveOnState = async ($: EngineInterface): Promise<void> => {
  const flag = currentMode() === 'on' ? ({ isOn: true, source: '/watchdog on' } as const) : ({ isOn: false } as const);
  await $.state.set({ plugin: 'watchdog', key: 'on' }, flag).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §5.2 step 1, §6.1, §8.3: the note tool, then one agent type for each watchdog that can run. Maps each slug
// to the reason that blocks it, or undefined.
const registerAll = async (
  $: EngineInterface,
  watchdogs: readonly Watchdog[]
): Promise<Map<string, string | undefined>> => {
  const noteProblem = await $.tool.register(NOTE_TOOL).then(() => undefined, errorText);
  if (noteProblem !== undefined) {
    return new Map(watchdogs.map((watchdog) => [watchdog.slug, noteProblem]));
  }
  const base = await $.fs.read(`${$.plugin.root}/prompts/system.md`);
  const problems = await Promise.all(
    watchdogs.map(async (watchdog) => {
      const spec = agentSpec(watchdog, systemPrompt(base, watchdog), sessionEffort());
      return $.agent.register(spec).then(() => {
        setRegisteredSpec(spec);
        return undefined;
      }, errorText);
    })
  );
  return new Map(watchdogs.map((watchdog, index) => [watchdog.slug, problems[index]]));
};

// §5.2 step 2: one 1-token call for each distinct model. Maps each model to its `no_model` reason, or undefined.
const preflightAll = async (
  $: EngineInterface,
  models: readonly string[]
): Promise<Map<string, string | undefined>> => {
  const distinct = [...new Set(models)];
  const problems = await Promise.all(
    distinct.map(async (model) => $.model.complete(preflightRequest(model)).then(preflightProblem, errorText))
  );
  return new Map(distinct.map((model, index) => [model, problems[index]]));
};

// §4.5: a searched path and its time at the read; a path that does not stat is not there.
const readSearchPath = async ($: EngineInterface, search: SearchPath): Promise<LoadedFile & WatchedFile> => {
  const mtimeMs = await $.fs.stat(search.path).then(
    (stat) => stat.mtimeMs,
    () => null
  );
  if (mtimeMs === null) {
    return { ...search, mtimeMs };
  }
  const content = await $.fs.read(search.path).then(
    (text) => ({ text }),
    (error: unknown) => ({ error: errorText(error) })
  );
  return { ...search, mtimeMs, content };
};

// §4.3, §4.5: the user file and the project files, read at `/watchdog on`; the roster stays frozen until the
// next `/watchdog on`.
const loadRoster = async ($: EngineInterface): Promise<{ roster: Roster; files: WatchedFile[] }> => {
  const where: Where = {
    configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    home: await $.env.get('HOME'),
    gitRoot: (await $.session.repo())?.root ?? null,
    cwd: await $.session.cwd(),
    root: await $.session.root(),
  };
  const files = await Promise.all(searchPaths(where, 'WATCHDOG.json').map(async (search) => readSearchPath($, search)));
  return { roster: buildRoster(files, where), files: files.map(({ path, mtimeMs }) => ({ path, mtimeMs })) };
};

// §4.5: "config changed" when a file time differs from the time of the last read. The status shows the
// roster only while on.
const checkConfig = async ($: EngineInterface): Promise<void> => {
  if (currentMode() !== 'on') {
    return;
  }
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

// §4.6, §13.2: one row with the warning count; from a `command.run` hook it waits, so it lands below the echo.
const logWarnings = ($: EngineInterface, count: number): void => {
  if (count > 0) {
    const text = `${count} WATCHDOG.json ${count === 1 ? 'warning' : 'warnings'}; see /watchdog status`;
    $.clock.after(COMMAND_LOG_DELAY_MS, () => {
      $.ui.log(text);
    });
  }
};

// §5.2: read the roster, register, preflight, move the feed cursors to the end, then set the on flag.
const turnOn = async ($: EngineInterface): Promise<void> => {
  const { roster, files } = await loadRoster($);
  const runnable = roster.watchdogs.filter((watchdog) => watchdog.isEnabled && watchdog.noModel === null);
  const blocked = await registerAll($, runnable);
  const noModel = await preflightAll(
    $,
    runnable.filter((watchdog) => blocked.get(watchdog.slug) === undefined).map((watchdog) => watchdog.model)
  );
  roster.watchdogs.forEach((watchdog) => {
    const problems = {
      isDisabled: !watchdog.isEnabled,
      blocked: blocked.get(watchdog.slug),
      noModel: watchdog.noModel ?? noModel.get(watchdog.model),
    };
    setSlot(watchdog.slug, slotAfterOn(slotOf(watchdog.slug), problems));
  });
  setRoster(roster, files);
  resetCadences();
  // A disabled, `no_model` or `blocked` watchdog keeps no cursor, so the feed does not keep its rows.
  const reviewers = roster.watchdogs.filter((watchdog) => {
    const { state } = slotOf(watchdog.slug);
    return state === 'idle' || state === 'reviewing';
  });
  setFeed(startFeed(reviewers.map((watchdog) => watchdog.slug)));
  setMode('on');
  await saveOnState($);
  logWarnings($, roster.warnings.length);
};

// §5.2: stop feed recording, clear the backlog and the held notes.
const turnOff = async ($: EngineInterface): Promise<void> => {
  setMode('off');
  setFeed(EMPTY_FEED);
  clearHeldNotes();
  await saveOnState($);
};

const onWatchdogCommand: Hook<'command.run'> = async ($, e, next) => {
  const subcommand = parseSubcommand(e.args);
  if (subcommand === 'status') {
    await checkConfig($);
    return { text: statusText(headline()) };
  }
  if (subcommand === 'unknown') {
    return { text: USAGE_REPLY };
  }
  if ((subcommand === 'on' || subcommand === 'off') && currentMode() === 'unsupported') {
    return { text: UNSUPPORTED_REPLY };
  }
  if (subcommand === 'on' || subcommand === 'off') {
    const problem = await (subcommand === 'on' ? turnOn($) : turnOff($)).then(() => undefined, errorText);
    return { text: problem === undefined ? statusText(headline()) : `watchdog ${subcommand} failed: ${problem}` };
  }
  return next(e);
};

export const installCommand = (on: OnEvents<'command.run'>): void => {
  on('command.run', { command: 'watchdog' }, onWatchdogCommand);
};
