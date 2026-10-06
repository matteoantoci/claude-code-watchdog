import { ownContext } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { isOwnToolCall } from '../agents/self-review';
import { addStatusHead, addStatusLines } from '../command/status';
import { NUDGE_WAIT_MS } from '../constants';
import { errorText } from '../errors';
import { currentMode } from '../lifecycle/mode';
import { addLogRecord, currentLog, errorRecord } from '../log/log';
import { addDeliveryRoute, heldNotes, holdNote, rerouteNotes, takeNotes } from '../note/notes';
import { isPersonPrompt } from '../person';
import {
  currentNudgeClock,
  currentRouting,
  endMainTurn,
  giveBackNudge,
  immuneTurnsWarning,
  lateRoute,
  nudgeStatus,
  nudgeValue,
  restoreNudge,
  routeNote,
  setImmuneTurns,
  setNudgeClock,
  spendNudge,
  startMainTurn,
} from './nudge';
import { countTurn, currentTurn, restoreTurn } from './turns';
import { wrapNotes, wrappedNote } from './wrapper';
import type { DeliveryState, HeldNote, Note } from '../note/notes';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, MatchedHook, PluginOptions, Timer } from 'claude-code';

type SteerHook = MatchedHook<'tool.call', { tool: RegExp }>;

// The shipped `prompts/boundary-guidance.md` (§10.7), read once; the 2 s wait of the nudge that waits
// (§10.3); whether this module instance read its `$.state` back (§14.6).
const memory: { guidance: string | undefined; wait: Timer | undefined; isLoaded: boolean } = {
  guidance: undefined,
  wait: undefined,
  isLoaded: false,
};

const guidance = async ($: EngineInterface): Promise<string> => {
  memory.guidance ??= await $.fs.read(`${$.plugin.root}/prompts/boundary-guidance.md`);
  return memory.guidance;
};

// §10.7: held notes in one wrapper, each under its watchdog's name, with its age now.
const wrapHeld = (head: string, notes: readonly HeldNote[]): string =>
  wrapNotes(
    head,
    notes.map((note) => wrappedNote(note, watchdogBySlug(note.watchdog)?.name ?? note.watchdog, currentTurn()))
  );

const isNudged = (note: HeldNote): boolean => note.delivery === 'nudged';

// §14.1: `$.state` keeps the budget, the cooldown and the nudge that waits with its notes; a refused write
// loses only what a reload would carry over.
const saveNudge = async ($: EngineInterface): Promise<void> => {
  const notes = heldNotes()
    .filter(isNudged)
    .map((note) => ({
      watchdog: note.watchdog,
      agentId: note.agentId,
      severity: note.severity,
      text: note.text,
      turn: note.turn,
      subagent: note.subagent,
    }));
  await $.state.set({ plugin: 'watchdog', key: 'nudge' }, nudgeValue(notes)).catch(() => undefined);
};

// §10.3: the route of a late note (a steer that got no tool result, or a refused append).
const lateDelivery = (note: HeldNote): DeliveryState => lateRoute(note.severity, currentRouting());

type Undelivered = {
  readonly notes: readonly HeldNote[];
  readonly route: (note: HeldNote) => DeliveryState;
  readonly error: string;
};

// §10.1, §10.3: notes that a delivery could not send wait again, each in the state `route` gives it; the
// review log gets one error.
const keepUndelivered = async ($: EngineInterface, undelivered: Undelivered): Promise<void> => {
  const { notes, route, error } = undelivered;
  for (const note of notes) {
    holdNote({ ...note, delivery: route(note) });
  }
  const names = notes.map((note) => watchdogBySlug(note.watchdog)?.name ?? note.watchdog);
  const watchdog = [...new Set(names)].join(', ');
  addLogRecord(errorRecord({ watchdog, time: await $.clock.now(), error }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

// §10.1: one user row with the wrapped notes. Returns the reason of a reject or a deny, or undefined.
const appendNotes = async ($: EngineInterface, notes: readonly HeldNote[]): Promise<string | undefined> => {
  try {
    const text = wrapHeld(await guidance($), notes);
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } });
    return 'deny' in appended ? appended.deny : undefined;
  } catch (error) {
    return errorText(error);
  }
};

// §10.1: a failed append keeps the notes undelivered: they take the late-note route (§10.3).
const steer = async ($: EngineInterface): Promise<void> => {
  const notes = takeNotes('steered');
  if (notes.length === 0) {
    return;
  }
  const problem = await appendNotes($, notes);
  if (problem !== undefined) {
    await keepUndelivered($, { notes, route: lateDelivery, error: `steer append failed: ${problem}` });
  }
};

// §10.1: the ready steers go after the next main-loop tool result, once `next(e)` resolved. The mod's own
// synthetic calls (§7.3) and every subagent call steer nothing.
const onToolCall: SteerHook = async ($, e, next) => {
  const result = await next(e);
  if (e.agentId === undefined && !isOwnToolCall(e, ownContext(), next.origin.plugin)) {
    await steer($);
  }
  return result;
};

// §10.3: one awaited `$.prompt.submit` with the wrapped notes. Returns the reason of a reject or a drop.
const submitNudge = async ($: EngineInterface, notes: readonly HeldNote[]): Promise<string | undefined> => {
  try {
    const submitted = await $.prompt.submit({ text: wrapHeld(await guidance($), notes) });
    return submitted.drop;
  } catch (error) {
    return errorText(error);
  }
};

// §10.3, §10.4: the callback of the 2 s wait sends one nudge with every late note that waits, while no turn
// runs (a nudge queued behind a turn would survive Esc). A refused nudge gives the budget back, and its
// notes wait as an aside.
const sendNudge = async ($: EngineInterface): Promise<void> => {
  memory.wait = undefined;
  setNudgeClock({ ...currentNudgeClock(), dueAt: null });
  const notes = currentRouting().isTurnRunning ? [] : takeNotes('nudged');
  if (notes.length > 0) {
    spendNudge();
  }
  await saveNudge($);
  const problem = notes.length === 0 ? undefined : await submitNudge($, notes);
  if (problem !== undefined) {
    giveBackNudge();
    await keepUndelivered($, { notes, route: () => 'held', error: `nudge failed: ${problem}` });
    await saveNudge($);
  }
};

const startWait = ($: EngineInterface, ms: number): void => {
  memory.wait = $.clock.after(ms, () => {
    sendNudge($).catch(() => undefined);
  });
};

// §10.3: late notes that wait while the session is idle start one 2 s wait; the notes ready within it share
// the nudge. Only a `turn.complete` (or the load) starts it: a submit from a timer that a `tool.call` hook
// set is refused, so the note hook never does.
const canArm = (): boolean =>
  !currentRouting().isTurnRunning && memory.wait === undefined && heldNotes().some(isNudged);

// The clock is read before the wait starts, so a wait that runs out at once finds `dueAt` set and its nudge's
// budget is not written over.
const armNudge = async ($: EngineInterface): Promise<void> => {
  if (!canArm()) {
    return;
  }
  const dueAt = (await $.clock.now()) + NUDGE_WAIT_MS;
  if (!canArm()) {
    return;
  }
  setNudgeClock({ ...currentNudgeClock(), dueAt });
  startWait($, NUDGE_WAIT_MS);
  await saveNudge($);
};

// §10.7: the main-loop counter adds 1 at each `turn.start`; `$.state` key `turns` keeps a copy (§14.1).
// §10.3 step 2: a turn that starts ends the 2 s wait, and its notes wait for a tool result of that turn.
const onTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  const turn = countTurn();
  startMainTurn(e.text);
  memory.wait?.cancel();
  memory.wait = undefined;
  rerouteNotes((note) => (isNudged(note) ? 'steered' : note.delivery));
  await $.state.set({ plugin: 'watchdog', key: 'turns' }, turn).catch(() => undefined);
  await saveNudge($);
  return next(e);
};

// §10.3: at the main-loop end, a steer with no tool result is a late note; after Esc (`isAborted`) it waits
// as an aside. Any `turn.complete` while the session is idle (a review's own too) starts the 2 s wait.
const onTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const result = await next(e);
  if (e.agentId === undefined) {
    endMainTurn(e.isAborted);
    rerouteNotes((note) => (note.delivery === 'steered' || isNudged(note) ? lateDelivery(note) : note.delivery));
  }
  await armNudge($);
  return result;
};

// §10.2, §13.1: the nits and the held notes in one wrapper; undefined when none waits. If the guidance
// cannot be read, they wait for the next person prompt.
const asideText = async ($: EngineInterface): Promise<string | undefined> => {
  const isWaiting = heldNotes().some((note) => note.delivery === 'aside on next prompt' || note.delivery === 'held');
  const head = isWaiting ? await guidance($).catch(() => undefined) : undefined;
  return head === undefined ? undefined : wrapHeld(head, takeNotes('aside on next prompt', 'held'));
};

// §10.2, §10.4: a person prompt resets the nudge budget and carries the aside in its `context`, added on
// the way down: a `context` added to the result after `next` is dropped (d.ts 8803-8805). Any other origin,
// a task notification too (§10.5), passes as it came.
const onPromptSubmit: Hook<'prompt.submit'> = async ($, e, next) => {
  if (!isPersonPrompt(e.origin)) {
    return next(e);
  }
  setNudgeClock({ ...currentNudgeClock(), nudges: 0 });
  await saveNudge($);
  const aside = await asideText($);
  return next(aside === undefined ? e : { ...e, context: [...(e.context ?? []), aside] });
};

// §10.3, §14.6: a reload cancels the old instance's timers. At load the counter, the budget, the cooldown
// and the nudge that waits come back from `$.state`, and the wait starts again with the time left.
const restoreDelivery = async ($: EngineInterface): Promise<void> => {
  memory.isLoaded = true;
  const turns = await $.state.get({ plugin: 'watchdog', key: 'turns' }).catch(() => undefined);
  const nudge = await $.state.get({ plugin: 'watchdog', key: 'nudge' }).catch(() => undefined);
  if (turns?.value !== undefined) {
    restoreTurn(turns.value);
  }
  for (const note of restoreNudge(nudge?.value)) {
    holdNote({ ...note, delivery: 'nudged' });
  }
  const { dueAt } = currentNudgeClock();
  if (dueAt !== null) {
    startWait($, Math.max(0, dueAt - (await $.clock.now())));
  }
};

const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  if (!memory.isLoaded) {
    await restoreDelivery($);
  }
  return result;
};

// §10.1 to §10.4: the route of each admitted note.
const route = (note: Note): DeliveryState => routeNote(note.severity, currentRouting());

export const installDelivery = (
  on: OnEvents<'turn.start' | 'turn.complete' | 'tool.call' | 'prompt.submit' | 'session.start'>,
  options: PluginOptions
): void => {
  setImmuneTurns(options.immuneTurns);
  on('turn.start', onTurnStart);
  on('turn.complete', { reason: /^/u }, onTurnComplete);
  on('tool.call', { tool: /^/u }, onToolCall);
  on('prompt.submit', onPromptSubmit);
  on('session.start', { isInteractive: [true, false] }, onSessionStart);
  addDeliveryRoute(route);
  addStatusHead(() => (currentMode() === 'on' ? nudgeStatus(currentRouting()) : []));
  addStatusLines(() => {
    const warning = immuneTurnsWarning();
    return warning === undefined ? [] : [`warning: ${warning}`];
  });
};
