import { currentRoster } from '../agents/roster';
import { currentTurn } from '../delivery/turns';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession } from '../lifecycle/on-order';
import { watchHeldNotes } from '../note/notes';
import { isPersonPrompt } from '../person';
import { EMPTY_BAND, bandState, changeCard, clearCards, restoreBand, toggleCard } from './cards';
import { troubleLine } from './problems';
import { bandTree } from './tree';
import type { OnEvents } from '../on';
import type { Trouble } from './problems';
import type { EngineInterface, Hook, MatchedHook, PluginState, RenderElement } from 'claude-code';

type BandHook = MatchedHook<'ui.render', { component: 'AbovePrompt' }>;

type Health = PluginState['watchdog']['health'];

// The band value this module instance last wrote to `$.state`, as JSON; whether it read the band back (§14.6).
const memory: { written: string | undefined; isLoaded: boolean } = { written: undefined, isLoaded: false };

// §13.1: a `$.state` write draws the band again; only a band that changed is written.
const writeBand = async ($: EngineInterface): Promise<void> => {
  const band = bandState(currentTurn());
  const json = JSON.stringify(band);
  if (json === memory.written) {
    return;
  }
  memory.written = json;
  await $.state.set({ plugin: 'watchdog', key: 'band' }, band).catch(() => {
    memory.written = undefined;
  });
};

// The note hook and the delivery hooks beneath change the cards; each of these hooks writes the band after them.
const afterTool: Hook<'tool.call'> = async ($, e, next) => {
  const result = await next(e);
  await writeBand($);
  return result;
};

const afterTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  const result = await next(e);
  await writeBand($);
  return result;
};

const afterTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const result = await next(e);
  await writeBand($);
  return result;
};

// §13.1: a person prompt clears the cards; the count line then shows no open note.
const onPrompt: Hook<'prompt.submit'> = async ($, e, next) => {
  if (isPersonPrompt(e.origin)) {
    clearCards();
  }
  const result = await next(e);
  await writeBand($);
  return result;
};

// §5.2 step 2: `/watchdog off` clears the cards.
const afterCommand: Hook<'command.run'> = async ($, e, next) => {
  const result = await next(e);
  if (currentMode() === 'off') {
    clearCards();
  }
  await writeBand($);
  return result;
};

// §13.1: a press on a card's Button expands or collapses it beneath, in its `onPress`; the band is written after.
const afterPress: Hook<'ui.press'> = async ($, e, next) => {
  const result = await next(e);
  await writeBand($);
  return result;
};

// §14.6: at module load the cards come back from `$.state`, so a reload keeps the band.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  if (!memory.isLoaded) {
    memory.isLoaded = true;
    const stored = await $.state.get({ plugin: 'watchdog', key: 'band' }).catch(() => undefined);
    restoreBand(stored?.value ?? EMPTY_BAND);
    memory.written = JSON.stringify(stored?.value ?? EMPTY_BAND);
  }
  return result;
};

// §12.5: the watchdogs of the roster in a problem state, as `$.state` key `health` keeps them.
const troubles = (health: Health | undefined): Trouble[] =>
  currentRoster().flatMap(({ name, slug }) => {
    const problem = health?.watchdogs[slug]?.problem ?? null;
    return problem === null ? [] : [{ name, problem }];
  });

// §12.5: the failure line while on; the clock is read only for a halt's next try.
const troubleText = async ($: EngineInterface, health: Health | undefined, columns: number) => {
  const found = troubles(health);
  const isHalted = found.some(({ problem }) => problem.state === 'halted');
  const now = isHalted ? await $.clock.now() : 0;
  return troubleLine(found, { now, columns, isAlone: currentRoster().length === 1 });
};

// §13.1: the `$.state` keys the band draws. Reading them subscribes the band, so each write draws it again.
const readKeys = async ($: EngineInterface) => {
  const on = await $.state.get({ plugin: 'watchdog', key: 'on' }).catch(() => undefined);
  const band = await $.state.get({ plugin: 'watchdog', key: 'band' }).catch(() => undefined);
  const health = await $.state.get({ plugin: 'watchdog', key: 'health' }).catch(() => undefined);
  const isOn = on?.value?.isOn;
  return { isOn, band: band?.value ?? EMPTY_BAND, health: isOn === true ? health?.value : undefined };
};

// §13.1: the band reads its keys first, also in a session it does not draw, so that a write that comes before
// the session start of a reload draws it. It yields to a survey, and draws nothing in a headless session (§10.6).
const onBand: BandHook = async ($, e, next) => {
  if (e.props.hasSurvey) {
    return next(e);
  }
  const base: RenderElement = await next(e);
  const { isOn, band, health } = await readKeys($);
  if (!isInteractiveSession() || currentMode() === 'unsupported') {
    return base;
  }
  const columns = e.props.bodyColumns;
  const trouble = await troubleText($, health, columns);
  const el = $.ui.resolve(e);
  const tree = bandTree(el, { isOn, band, trouble, columns, onToggle: toggleCard });
  if (tree === undefined) {
    return base;
  }
  // §13.1: no row above the count line. The engine draws its `[-]` on the band's first row, so a blank row there
  // would hold the `[-]` alone, above the rule.
  return el.Box({ key: 'watchdog-band', flexDirection: 'column', children: [base, tree] });
};

// Install first, so that these hooks sit above the note, delivery and command hooks that change the cards.
// The matchers only tell these `on()` from the other areas'.
export const installBand = (
  on: OnEvents<
    | 'tool.call'
    | 'turn.start'
    | 'turn.complete'
    | 'prompt.submit'
    | 'command.run'
    | 'session.start'
    | 'ui.render'
    | 'ui.press'
  >
): void => {
  watchHeldNotes(changeCard);
  on('tool.call', { tool: /./u }, afterTool);
  on('turn.start', { turnId: /^/u }, afterTurnStart);
  on('turn.complete', { answer: /^/u }, afterTurnComplete);
  on('prompt.submit', { origin: { kind: /./u } }, onPrompt);
  on('command.run', { command: /^watchdog$/u }, afterCommand);
  on('session.start', { cwd: /./u }, onSessionStart);
  on('ui.render', { component: 'AbovePrompt' }, onBand);
  on('ui.press', { plugin: 'watchdog', element: /^watchdog-expand-/u }, afterPress);
};
