import { preflightProblem, preflightRequest } from '../agents/preflight';
import { DEFAULT_WATCHDOG, setRoster } from '../agents/roster';
import { agentSpec } from '../agents/spec';
import { systemPrompt } from '../agents/system-prompt';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { dumpPath, dumpText, configDir } from '../dump/dump';
import { addDumpLines, dumpLines } from '../dump/sections';
import { errorText } from '../errors';
import { EMPTY_FEED, currentFeed, setFeed, startFeed } from '../feed/feed';
import { currentMode, setMode } from '../lifecycle/mode';
import {
  DESKTOP_DROP_WARNING,
  addOnWarning,
  currentOnSource,
  hasPrompted,
  isEnvOnFlag,
  isOnByDefault,
  onStoreKey,
  onWarnings,
  pickOnFlag,
  setInteractiveSession,
  setOnByDefault,
  setOnSource,
} from '../lifecycle/on-order';
import { currentLog, recentPrompts } from '../log/log';
import { clearHeldNotes } from '../note/notes';
import { NOTE_TOOL } from '../note/tool';
import { setSlot, slotAfterOn, slotOf } from '../review/slots';
import { parseSubcommand } from './args';
import { UNSUPPORTED_REPLY, USAGE_REPLY } from './spec';
import { addStatusLines, statusText } from './status';
import type { Watchdog } from '../agents/roster';
import type { OnFlag, OnSource } from '../lifecycle/on-order';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, PluginOptions } from 'claude-code';

const headline = (): string =>
  currentMode() === 'unsupported' ? `watchdog unsupported: ${UNSUPPORTED_REPLY}` : `watchdog ${currentMode()}`;

// §5.2 step 4, §14.1: `$.state` keeps the on flag and the feed. The live copies are module memory, so a
// refused write loses only what a reload would carry over.
const saveOnState = async ($: EngineInterface): Promise<void> => {
  const source = currentOnSource();
  const flag: OnFlag = currentMode() === 'on' && source !== undefined ? { isOn: true, source } : { isOn: false };
  await $.state.set({ plugin: 'watchdog', key: 'on' }, flag).catch(() => undefined);
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §5.2 step 1, §6.1, §8.3: the note tool, then one agent type for each watchdog. Returns the reason that
// blocks each watchdog, or undefined.
const registerAll = async ($: EngineInterface, roster: readonly Watchdog[]): Promise<(string | undefined)[]> => {
  const noteProblem = await $.tool.register(NOTE_TOOL).then(() => undefined, errorText);
  if (noteProblem !== undefined) {
    return roster.map(() => noteProblem);
  }
  const base = await $.fs.read(`${$.plugin.root}/prompts/system.md`);
  return Promise.all(
    roster.map(async (watchdog) =>
      $.agent.register(agentSpec(watchdog, systemPrompt(base, watchdog))).then(() => undefined, errorText)
    )
  );
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

// §5.2: register, preflight, move the feed cursors to the end, then set the on flag and the on source.
const turnOn = async ($: EngineInterface, source: OnSource): Promise<void> => {
  const roster = [DEFAULT_WATCHDOG];
  const blocked = await registerAll($, roster);
  const noModel = await preflightAll(
    $,
    roster.filter((_watchdog, index) => blocked[index] === undefined).map((watchdog) => watchdog.model)
  );
  roster.forEach((watchdog, index) => {
    const problems = { blocked: blocked[index], noModel: noModel.get(watchdog.model) };
    setSlot(watchdog.slug, slotAfterOn(slotOf(watchdog.slug), problems));
  });
  setRoster(roster);
  setFeed(startFeed(roster.map((watchdog) => watchdog.slug)));
  setMode('on');
  setOnSource(source);
  await saveOnState($);
};

// §5.2: stop feed recording, clear the backlog and the held notes.
const turnOff = async ($: EngineInterface): Promise<void> => {
  setMode('off');
  setOnSource(undefined);
  setFeed(EMPTY_FEED);
  clearHeldNotes();
  await saveOnState($);
};

// §5.4: the person's toggle follows the session id into a new process (`claude -r`), with `lastUsed` (§14.2).
const storeOnFlag = async ($: EngineInterface, flag: OnFlag): Promise<void> => {
  const sessionId = await $.session.id();
  await $.store.set(onStoreKey(sessionId), { ...flag, lastUsed: Date.now() });
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
  $.state.get({ plugin: 'watchdog', key: 'on' }).then(
    (read) => read.value,
    () => undefined
  );

const readStoredFlag = async ($: EngineInterface): Promise<unknown> => {
  const sessionId = await $.session.id();
  return $.store.get(onStoreKey(sessionId));
};

// §5.1: the `$.state` flag (undefined when dropped), then for an interactive session the stored flag and
// `onByDefault`. A failed turn-on writes one log row.
const applyOrder = async ($: EngineInterface, state: unknown, isInteractive: boolean): Promise<void> => {
  const stored = isInteractive ? await readStoredFlag($).catch(() => undefined) : undefined;
  const flag = pickOnFlag({ state, stored, onByDefault: isOnByDefault(), isInteractive });
  const problem = flag === undefined ? undefined : await applyOnFlag($, flag).then(() => undefined, errorText);
  if (problem !== undefined) {
    $.ui.log(`watchdog on failed: ${problem}`);
  }
};

// §5.1: after the version gate (the lifecycle hook beneath this one), set the on state by the order.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  setInteractiveSession(e.isInteractive);
  if (currentMode() !== 'unsupported') {
    await applyOrder($, await readOnState($), e.isInteractive);
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

const onWatchdogCommand: Hook<'command.run'> = async ($, e) => {
  const subcommand = parseSubcommand(e.args);
  if (subcommand === 'status') {
    return { text: statusText(headline()) };
  }
  if (subcommand === 'unknown') {
    return { text: USAGE_REPLY };
  }
  if ((subcommand === 'on' || subcommand === 'off') && currentMode() === 'unsupported') {
    return { text: UNSUPPORTED_REPLY };
  }
  if (subcommand === 'on' || subcommand === 'off') {
    const problem = await toggle($, subcommand === 'on').then(() => undefined, errorText);
    return { text: problem === undefined ? statusText(headline()) : `watchdog ${subcommand} failed: ${problem}` };
  }
  const reply = await writeDump($, subcommand === 'dump raw').catch(
    (error: unknown) => `watchdog dump failed: ${errorText(error)}`
  );
  return { text: reply };
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
