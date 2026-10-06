import { preflightProblem, preflightRequest } from '../agents/preflight';
import { DEFAULT_WATCHDOG, setRoster } from '../agents/roster';
import { agentSpec } from '../agents/spec';
import { systemPrompt } from '../agents/system-prompt';
import { errorText } from '../errors';
import { EMPTY_FEED, currentFeed, setFeed, startFeed } from '../feed/feed';
import { currentMode, setMode } from '../lifecycle/mode';
import { clearHeldNotes } from '../note/notes';
import { NOTE_TOOL } from '../note/tool';
import { setSlot, slotAfterOn, slotOf } from '../review/slots';
import { parseSubcommand } from './args';
import { UNSUPPORTED_REPLY, USAGE_REPLY } from './spec';
import { statusText } from './status';
import type { Watchdog } from '../agents/roster';
import type { OnEvents } from '../on';
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

// §5.2: register, preflight, move the feed cursors to the end, then set the on flag.
const turnOn = async ($: EngineInterface): Promise<void> => {
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
  await saveOnState($);
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
