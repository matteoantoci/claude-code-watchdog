import { preflightProblem, preflightReject, preflightRequest } from '../agents/preflight';
import { setRegisteredSpec } from '../agents/registered';
import { setRoster } from '../agents/roster';
import { agentSpec } from '../agents/spec';
import { systemPrompt } from '../agents/system-prompt';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { currentNudgeClock, nudgeValue, setNudgeClock } from '../delivery/nudge';
import { addDumpLines } from '../dump/sections';
import { errorText } from '../errors';
import { EMPTY_FEED, currentFeed, setFeed, startFeed } from '../feed/feed';
import { freezeGuidance } from '../guidance/memory';
import { currentMode, setMode } from '../lifecycle/mode';
import {
  DESKTOP_DROP_WARNING,
  addOnWarning,
  currentOnSource,
  hasPrompted,
  isEnvOn,
  isEnvOnFlag,
  isInteractiveSession,
  isOnByDefault,
  onStoreKey,
  onWarnings,
  pickOnFlag,
  setInteractiveSession,
  setOnByDefault,
  setOnSource,
} from '../lifecycle/on-order';
import { clearHeldNotes } from '../note/notes';
import { NOTE_TOOL } from '../note/tool';
import { resetCadences } from '../review/cadence';
import { slotsAfterOn } from '../review/slots';
import { buildRoster } from '../roster/merge';
import { sessionEffort } from '../roster/model';
import { searchPaths } from '../roster/paths';
import { parseSubcommand } from './args';
import { UNSUPPORTED_REPLY, USAGE_REPLY } from './spec';
import { addStatusLines, statusHeadline, statusText } from './status';
import type { Roster, WatchedFile, Watchdog } from '../agents/roster';
import type { OnFlag, OnSource } from '../lifecycle/on-order';
import type { OnEvents } from '../on';
import type { LoadedFile } from '../roster/merge';
import type { SearchPath, Where } from '../roster/paths';
import type { EngineInterface, Hook, PluginOptions } from 'claude-code';

// §5.2 step 4, §14.1: `$.state` keeps the on flag and the feed; a refused write loses only the carry-over.
const saveOnState = async ($: EngineInterface): Promise<void> => {
  const source = currentOnSource();
  const flag: OnFlag = currentMode() === 'on' && source !== undefined ? { isOn: true, source } : { isOn: false };
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
    distinct.map(async (model) =>
      $.model.complete(preflightRequest(model)).then(preflightProblem, preflightReject(model))
    )
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

// §4.3, §4.5: the user file and the project files of `WATCHDOG.json` and `WATCHDOG.md`, read at `/watchdog on`;
// the roster and the guidance (§4.4) stay frozen until the next `/watchdog on`.
const loadRoster = async ($: EngineInterface): Promise<{ roster: Roster; files: WatchedFile[] }> => {
  const where: Where = {
    configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    home: await $.env.get('HOME'),
    gitRoot: (await $.session.repo())?.root ?? null,
    cwd: await $.session.cwd(),
    root: await $.session.root(),
  };
  const read = async (name: string): Promise<(LoadedFile & WatchedFile)[]> =>
    Promise.all(searchPaths(where, name).map(async (search) => readSearchPath($, search)));
  const [files, guides] = await Promise.all([read('WATCHDOG.json'), read('WATCHDOG.md')]);
  freezeGuidance(guides);
  const watched = [...files, ...guides].map(({ path, mtimeMs }) => ({ path, mtimeMs }));
  return { roster: buildRoster(files, where), files: watched };
};

// §4.6, §13.2: one row with the warning count; it waits, so that from a `command.run` hook it lands below the
// command echo.
const logWarnings = ($: EngineInterface, count: number): void => {
  if (count > 0) {
    const text = `${count} WATCHDOG.json ${count === 1 ? 'warning' : 'warnings'}; see /watchdog status`;
    $.clock.after(COMMAND_LOG_DELAY_MS, () => {
      $.ui.log(text);
    });
  }
};

// §5.2: read the roster, register, preflight, move the feed cursors to the end, then set the on flag and the
// on source. The roster is set before the register, whose system prompt reads it (§8.1).
const turnOn = async ($: EngineInterface, source: OnSource): Promise<void> => {
  const { roster, files } = await loadRoster($);
  setRoster(roster, files);
  const runnable = roster.watchdogs.filter((watchdog) => watchdog.isEnabled && watchdog.noModel === null);
  const blocked = await registerAll($, runnable);
  const noModel = await preflightAll(
    $,
    runnable.filter((watchdog) => blocked.get(watchdog.slug) === undefined).map((watchdog) => watchdog.model)
  );
  const reviewers = slotsAfterOn(roster.watchdogs, blocked, noModel);
  resetCadences();
  setFeed(startFeed(reviewers));
  setMode('on');
  setOnSource(source);
  await saveOnState($);
  logWarnings($, roster.warnings.length);
};

// §5.2: stop feed recording; clear the backlog, the held notes and a waiting nudge, in `$.state` too.
const turnOff = async ($: EngineInterface): Promise<void> => {
  setMode('off');
  setOnSource(undefined);
  setFeed(EMPTY_FEED);
  clearHeldNotes();
  setNudgeClock({ ...currentNudgeClock(), dueAt: null });
  await saveOnState($);
  await $.state.set({ plugin: 'watchdog', key: 'nudge' }, nudgeValue([])).catch(() => undefined);
};

// §5.4: the person's toggle follows the session id into a new process (`claude -r`), with `lastUsed` (§14.2).
const storeOnFlag = async ($: EngineInterface, flag: OnFlag): Promise<void> => {
  const sessionId = await $.session.id();
  await $.store.set(onStoreKey(sessionId), { ...flag, lastUsed: await $.clock.now() });
};

const toggle = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await (isOn ? turnOn($, '/watchdog on') : turnOff($));
  await storeOnFlag($, isOn ? { isOn: true, source: '/watchdog on' } : { isOn: false }).catch(() => undefined);
};

// §5.1: switch to the flag that the order picked. An off session that stays off writes nothing, so a later
// `onByDefault` still applies after a reload.
const applyOnFlag = async ($: EngineInterface, flag: OnFlag): Promise<void> => {
  if (flag.isOn && currentMode() === 'on') {
    setOnSource(flag.source);
    await saveOnState($);
    return;
  }
  if (flag.isOn || currentMode() === 'on') {
    await (flag.isOn ? turnOn($, flag.source) : turnOff($));
  }
};

const readOnState = async ($: EngineInterface): Promise<unknown> =>
  (await $.state.get({ plugin: 'watchdog', key: 'on' }).catch(() => undefined))?.value;

const readStoredFlag = async ($: EngineInterface): Promise<unknown> => {
  const sessionId = await $.session.id();
  return $.store.get(onStoreKey(sessionId));
};

// §5.1: the `$.state` flag (undefined when dropped), then for an interactive session the stored flag and
// `onByDefault`. A failed turn-on writes one log row.
const applyOrder = async ($: EngineInterface, state: unknown, isInteractive: boolean): Promise<void> => {
  const stored = isInteractive ? await readStoredFlag($).catch(() => undefined) : undefined;
  const flag = pickOnFlag({ state, stored, onByDefault: isOnByDefault(), isInteractive, isEnvOn: isEnvOn() });
  const problem = flag === undefined ? undefined : await applyOnFlag($, flag).then(() => undefined, errorText);
  if (problem !== undefined) {
    $.ui.log(`watchdog on failed: ${problem}`);
  }
};

// §5.1: after the version gate beneath, set the on state by the order; §14.6: a desktop reload is interactive.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  setInteractiveSession(e.isInteractive);
  if (currentMode() !== 'unsupported') {
    await applyOrder($, await readOnState($), isInteractiveSession());
  }
  return result;
};

// §5.3: a Desktop attach before the first prompt makes the session interactive. It drops an on state from
// `CLAUDE_WATCHDOG` with one dump warning, then applies the order.
const onDesktopAttach: Hook<'session.attach'> = async ($, e, next) => {
  const result = await next(e);
  if (hasPrompted() || currentMode() === 'unsupported') {
    return result;
  }
  setInteractiveSession(true);
  const state = await readOnState($);
  const isDropped = isEnvOnFlag(state);
  if (isDropped) {
    addOnWarning(DESKTOP_DROP_WARNING);
  }
  await applyOrder($, isDropped ? undefined : state, true);
  return result;
};
// §5.2, §13.3: on, off and status; `dump` goes to the dump hook beneath.
const onWatchdogCommand: Hook<'command.run'> = async ($, e, next) => {
  const subcommand = parseSubcommand(e.args);
  if (subcommand === 'status') {
    return { text: statusText(statusHeadline()) };
  }
  if (subcommand === 'unknown') {
    return { text: USAGE_REPLY };
  }
  if ((subcommand === 'on' || subcommand === 'off') && currentMode() === 'unsupported') {
    return { text: UNSUPPORTED_REPLY };
  }
  if (subcommand === 'on' || subcommand === 'off') {
    const problem = await toggle($, subcommand === 'on').then(() => undefined, errorText);
    return { text: problem === undefined ? statusText(statusHeadline()) : `watchdog ${subcommand} failed: ${problem}` };
  }
  return next(e);
};

// §5.4, §13.3, §13.4: the on source in the status while on, and always in the dump with the warnings.
const onSourceLine = (): string => `on source: ${currentOnSource() ?? 'none (off)'}`;

export const installCommand = (
  on: OnEvents<'command.run' | 'session.start' | 'session.attach'>,
  options: PluginOptions
): void => {
  setOnByDefault(options);
  on('command.run', { command: 'watchdog' }, onWatchdogCommand);
  on('session.start', { cwd: /^/u }, onSessionStart);
  on('session.attach', { surface: 'desktop' }, onDesktopAttach);
  addStatusLines(() => (currentMode() === 'on' ? [onSourceLine()] : []));
  addDumpLines(() => [onSourceLine(), ...onWarnings().map((warning) => `warning: ${warning}`)]);
};
