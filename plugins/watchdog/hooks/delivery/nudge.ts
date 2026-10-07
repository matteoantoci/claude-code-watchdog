import { BLOCKER_NUDGE_BUDGET, DEFAULT_IMMUNE_TURNS, MAX_IMMUNE_TURNS, NUDGE_BUDGET } from '../constants';
import { isInteractiveSession } from '../lifecycle/on-order';
import { currentTurn } from './turns';
import type { DeliveryState, HeldNote, Note } from '../note/notes';
import type { Severity } from '../note/tool';
import type { PluginState } from 'claude-code';

// §10.3, §10.4, §14.1: the `$.state` key `nudge`.
export type Nudge = PluginState['watchdog']['nudge'];

export type NudgeNote = Nudge['notes'][number];

// The `nudge` key less its notes: module memory keeps the notes in the held list.
export type NudgeClock = Omit<Nudge, 'notes'>;

// §10.4: the budget a nudge takes, by its count in the `nudge` key: `blockerNudges` for a nudge that carries a
// blocker, `nudges` for a nudge of concerns alone.
export type NudgeBudget = 'nudges' | 'blockerNudges';

const BUDGET_TOPS: Readonly<Record<NudgeBudget, number>> = {
  nudges: NUDGE_BUDGET,
  blockerNudges: BLOCKER_NUDGE_BUDGET,
};

// The main loop as the routes read it: the §10.7 counter, a main turn that runs, the end of the last one.
export type MainLoop = {
  readonly turn: number;
  readonly isTurnRunning: boolean;
  readonly isAfterEsc: boolean;
};

// `isHeadless`: a `-p` or SDK session (§5.3), which has no nudge and no cards (§10.6).
export type Routing = MainLoop &
  Omit<NudgeClock, 'dueAt'> & { readonly immuneTurns: number; readonly isHeadless: boolean };

type Cooldown = Pick<Routing, 'turn' | 'nudgeTurn' | 'immuneTurns'>;

// §10.3: the model reads the mod's own prompt under this frame; the `turn.start` text of the nudge turn starts with it.
const NUDGE_FRAME = 'The watchdog plugin sent a message:';

// §10.4: the cooldown lasts while the counter minus its value at the nudge turn is `immuneTurns` or less.
const isInCooldown = (at: Cooldown): boolean => at.nudgeTurn !== null && at.turn - at.nudgeTurn <= at.immuneTurns;

// §13.3: the main turns of the cooldown still to come.
export const cooldownLeft = (at: Cooldown): number =>
  at.nudgeTurn === null ? 0 : Math.max(0, at.nudgeTurn + at.immuneTurns - at.turn);

// §10.3, §10.4: a late concern or blocker waits for a nudge as `nudge pending` while its budget of the person prompt
// lasts: 1 nudge of concerns, 2 that carry a blocker. Over its budget, after Esc, or a concern in the cooldown (which
// covers the nudge turn): `held`, a card and an aside on the next person prompt. §10.6: a headless session has no
// nudge and no cards: the note waits as an aside.
export const lateRoute = (severity: Severity, at: Routing): 'nudge pending' | 'held' | 'aside on next prompt' => {
  if (at.isHeadless) {
    return 'aside on next prompt';
  }
  const isSpent =
    severity === 'blocker' ? at.blockerNudges >= BLOCKER_NUDGE_BUDGET : at.nudges >= NUDGE_BUDGET || isInCooldown(at);
  return isSpent || at.isAfterEsc ? 'held' : 'nudge pending';
};

// §10.1 to §10.4: a nit waits for the next person prompt; a concern or blocker steers while a main turn
// runs, else it is a late note.
export const routeNote = (severity: Severity, at: Routing): DeliveryState => {
  if (severity === 'nit') {
    return 'aside on next prompt';
  }
  return at.isTurnRunning ? 'steered' : lateRoute(severity, at);
};

// §10.3: a late note that waits for the nudge.
export const isNudgePending = (note: HeldNote): boolean => note.delivery === 'nudge pending';

// §14.1: the late notes of the nudge that waits, as the `nudge` key keeps them.
export const nudgeNotes = (notes: readonly HeldNote[]): NudgeNote[] =>
  notes.filter(isNudgePending).map((note) => ({
    watchdog: note.watchdog,
    agentId: note.agentId,
    severity: note.severity,
    text: note.text,
    batchEdits: note.batchEdits,
    turn: note.turn,
    subagent: note.subagent,
    reviewWait: note.reviewWait,
  }));

// §10.4: a nudge that carries a blocker takes the blocker budget, and the concerns in it ride along; a nudge of
// concerns alone takes the concern budget.
export const budgetOf = (notes: readonly Pick<Note, 'severity'>[]): NudgeBudget =>
  notes.some((note) => note.severity === 'blocker') ? 'blockerNudges' : 'nudges';

// §13.3: the two nudge budgets and the cooldown on the status first line.
export const nudgeStatus = (at: Routing): readonly string[] => [
  `nudge ${at.nudges}/${NUDGE_BUDGET}`,
  `blocker ${at.blockerNudges}/${BLOCKER_NUDGE_BUDGET}`,
  `cooldown ${cooldownLeft(at)}`,
];

// §4.1: a whole number from 0 to 5. An absent value is the default; a bad one is the default with a warning.
export const immuneTurnsOf = (value: unknown): { readonly immuneTurns: number; readonly warning?: string } => {
  if (value === undefined) {
    return { immuneTurns: DEFAULT_IMMUNE_TURNS };
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_IMMUNE_TURNS
    ? { immuneTurns: value }
    : {
        immuneTurns: DEFAULT_IMMUNE_TURNS,
        warning: `immuneTurns ${JSON.stringify(value)} is not a whole number from 0 to ${MAX_IMMUNE_TURNS}; the cooldown is ${DEFAULT_IMMUNE_TURNS} turns`,
      };
};

// The live routing state in module memory; `$.state` key `nudge` keeps the clock and the notes of a nudge
// that waits (§10.3), so a reload sets the wait again.
const memory: {
  loop: Omit<MainLoop, 'turn'>;
  clock: NudgeClock;
  immuneTurns: number;
  warning: string | undefined;
} = {
  loop: { isTurnRunning: false, isAfterEsc: false },
  clock: { nudges: 0, blockerNudges: 0, nudgeTurn: null, dueAt: null },
  immuneTurns: DEFAULT_IMMUNE_TURNS,
  warning: undefined,
};

export const currentRouting = (): Routing => ({
  turn: currentTurn(),
  ...memory.loop,
  nudges: memory.clock.nudges,
  blockerNudges: memory.clock.blockerNudges,
  nudgeTurn: memory.clock.nudgeTurn,
  immuneTurns: memory.immuneTurns,
  isHeadless: !isInteractiveSession(),
});

// §10.1 to §10.4, §11.4: the route of an admitted note now.
export const routeNow = (note: Note): DeliveryState => routeNote(note.severity, currentRouting());

// §10.3: the route of a late note now (a steer that got no tool result, or a refused append).
export const lateRouteNow = (note: Note): DeliveryState => lateRoute(note.severity, currentRouting());

// §4.1: the value of `register(on, options)`; §4.6: the status warning of a bad one.
export const setImmuneTurns = (value: unknown): void => {
  const { immuneTurns, warning } = immuneTurnsOf(value);
  memory.immuneTurns = immuneTurns;
  memory.warning = warning;
};

export const immuneTurnsWarning = (): string | undefined => memory.warning;

// A main-loop `turn.start`, after the counter added 1: a turn that starts ends the 2 s wait (§10.3 step 2),
// and the nudge's own turn starts the cooldown (§10.4).
export const startMainTurn = (text: string): void => {
  const isNudgeTurn = text.startsWith(NUDGE_FRAME);
  memory.loop = { isTurnRunning: true, isAfterEsc: false };
  memory.clock = { ...memory.clock, dueAt: null, nudgeTurn: isNudgeTurn ? currentTurn() : memory.clock.nudgeTurn };
};

// A main-loop `turn.complete`; §10.3: Esc shows as `isAborted`.
export const endMainTurn = (isAborted: boolean): void => {
  memory.loop = { ...memory.loop, isTurnRunning: false, isAfterEsc: isAborted };
};

// §10.3, §10.4: the two budgets, the cooldown start and the end of the 2 s wait of the nudge that waits.
export const currentNudgeClock = (): NudgeClock => memory.clock;

export const setNudgeClock = (clock: NudgeClock): void => {
  memory.clock = clock;
};

// §10.4: a nudge that goes out takes one of its budget (`budgetOf`) for its person prompt, never past the top.
export const spendNudge = (budget: NudgeBudget): void => {
  memory.clock = { ...memory.clock, [budget]: Math.min(BUDGET_TOPS[budget], memory.clock[budget] + 1) };
};

// §10.3, §10.4: a refused nudge gives back what it took. A person prompt that came while the nudge was in flight
// already reset the budgets, so a count never goes below 0.
export const giveBackNudge = (budget: NudgeBudget): void => {
  memory.clock = { ...memory.clock, [budget]: Math.max(0, memory.clock[budget] - 1) };
};

// The `$.state` value: the clock and the late notes of the nudge that waits.
export const nudgeValue = (notes: readonly NudgeNote[]): Nudge => ({
  ...memory.clock,
  notes: memory.clock.dueAt === null ? [] : notes,
});

// §10.3, §14.6: at load the clock comes back from `$.state`; the notes go back to the held list.
export const restoreNudge = (value: Nudge | undefined): readonly NudgeNote[] => {
  if (value === undefined) {
    return [];
  }
  memory.clock = {
    nudges: value.nudges,
    blockerNudges: value.blockerNudges,
    nudgeTurn: value.nudgeTurn,
    dueAt: value.dueAt,
  };
  return value.dueAt === null ? [] : value.notes;
};
