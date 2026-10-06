import { describe, expect, test } from 'claude-code/testing';
import { cooldownLeft, immuneTurnsOf, routeNote } from '../hooks/delivery/nudge';
import { isPersonPrompt } from '../hooks/delivery/person';
import type { Routing } from '../hooks/delivery/nudge';

// The main loop is idle after turn 4, no nudge went out since the person prompt, and the cooldown is 3 turns.
const IDLE: Routing = {
  turn: 4,
  isTurnRunning: false,
  isAfterEsc: false,
  isNudgeTurn: false,
  nudges: 0,
  nudgeTurn: null,
  immuneTurns: 3,
};

describe('the person prompt set', () => {
  test('composer, bridge, sdk and slack-ping are person prompts', () => {
    for (const kind of ['composer', 'bridge', 'sdk', 'slack-ping'] as const) {
      expect(isPersonPrompt({ kind })).toBe(true);
    }
  });

  test('a task notification, a plugin, a peer, a schedule and an unstamped prompt are not', () => {
    expect(isPersonPrompt({ kind: 'task-notification' })).toBe(false);
    expect(isPersonPrompt({ kind: 'plugin', name: 'watchdog' })).toBe(false);
    expect(isPersonPrompt({ kind: 'peer-send-message' })).toBe(false);
    expect(isPersonPrompt({ kind: 'scheduled-trigger' })).toBe(false);
    expect(isPersonPrompt({ kind: 'unclassified' })).toBe(false);
    expect(isPersonPrompt(undefined)).toBe(false);
  });
});

describe('the route of an admitted note', () => {
  test('a nit waits for the next person prompt, also while a turn runs', () => {
    expect(routeNote('nit', IDLE)).toBe('aside on next prompt');
    expect(routeNote('nit', { ...IDLE, isTurnRunning: true })).toBe('aside on next prompt');
  });

  test('a concern or a blocker while a main turn runs waits for the next tool result', () => {
    expect(routeNote('concern', { ...IDLE, isTurnRunning: true })).toBe('steered');
    expect(routeNote('blocker', { ...IDLE, isTurnRunning: true, nudges: 1, isAfterEsc: true })).toBe('steered');
  });

  test('a late concern or blocker gets the one nudge of the person prompt', () => {
    expect(routeNote('concern', IDLE)).toBe('nudged');
    expect(routeNote('blocker', IDLE)).toBe('nudged');
  });

  test('over budget, after Esc and after the nudge turn a late note waits for the next person prompt', () => {
    for (const routing of [
      { ...IDLE, nudges: 1 },
      { ...IDLE, isAfterEsc: true },
      { ...IDLE, isNudgeTurn: true },
    ]) {
      expect(routeNote('concern', routing)).toBe('held');
      expect(routeNote('blocker', routing)).toBe('held');
    }
  });

  test('the cooldown holds a late concern for immuneTurns main turns after the nudge turn; a blocker is exempt', () => {
    // Nudge turn 2: turns 2 to 5 cool down with immuneTurns 3, turn 6 does not.
    const cooled = { ...IDLE, nudgeTurn: 2 };
    expect(routeNote('concern', { ...cooled, turn: 5 })).toBe('held');
    expect(routeNote('blocker', { ...cooled, turn: 5 })).toBe('nudged');
    expect(routeNote('concern', { ...cooled, turn: 6 })).toBe('nudged');
    expect(routeNote('concern', { ...cooled, turn: 2, immuneTurns: 0 })).toBe('held');
    expect(routeNote('concern', { ...cooled, turn: 3, immuneTurns: 0 })).toBe('nudged');
  });
});

describe('the cooldown the status shows', () => {
  test('the main turns of the cooldown still to come; 0 before the first nudge', () => {
    expect(cooldownLeft(IDLE)).toBe(0);
    expect(cooldownLeft({ ...IDLE, turn: 2, nudgeTurn: 2 })).toBe(3);
    expect(cooldownLeft({ ...IDLE, turn: 4, nudgeTurn: 2 })).toBe(1);
    expect(cooldownLeft({ ...IDLE, turn: 9, nudgeTurn: 2 })).toBe(0);
  });
});

describe('immuneTurns', () => {
  test('a whole number from 0 to 5 stands, and an absent value is 3 with no warning', () => {
    expect(immuneTurnsOf(0)).toEqual({ immuneTurns: 0 });
    expect(immuneTurnsOf(5)).toEqual({ immuneTurns: 5 });
    expect(immuneTurnsOf(undefined)).toEqual({ immuneTurns: 3 });
  });

  test('a bad value is 3, with a warning for /watchdog status', () => {
    for (const bad of [6, -1, 2.5, '2', true]) {
      expect(immuneTurnsOf(bad).immuneTurns).toBe(3);
    }
    expect(immuneTurnsOf(7).warning).toBe('immuneTurns 7 is not a whole number from 0 to 5; the cooldown is 3 turns');
  });
});
