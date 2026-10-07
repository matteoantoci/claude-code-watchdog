import { describe, expect, test } from 'claude-code/testing';
import { budgetOf, cooldownLeft, immuneTurnsOf, nudgeStatus, routeNote } from '../hooks/delivery/nudge';
import { isPersonPrompt } from '../hooks/person';
import type { Routing } from '../hooks/delivery/nudge';

// The main loop is idle after turn 4, no nudge went out since the person prompt, and the cooldown is 3 turns.
const IDLE: Routing = {
  turn: 4,
  isTurnRunning: false,
  isAfterEsc: false,
  nudges: 0,
  blockerNudges: 0,
  nudgeTurn: null,
  immuneTurns: 3,
  isHeadless: false,
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
    expect(routeNote('blocker', { ...IDLE, isTurnRunning: true, blockerNudges: 2, isAfterEsc: true })).toBe('steered');
  });

  test('a late concern or blocker waits for a nudge while its budget of the person prompt lasts', () => {
    expect(routeNote('concern', IDLE)).toBe('nudge pending');
    expect(routeNote('blocker', IDLE)).toBe('nudge pending');
  });

  test('in a headless session a late concern or blocker waits as an aside, and a steer still steers', () => {
    const headless = { ...IDLE, isHeadless: true };
    expect(routeNote('concern', headless)).toBe('aside on next prompt');
    expect(routeNote('blocker', headless)).toBe('aside on next prompt');
    expect(routeNote('blocker', { ...headless, isTurnRunning: true })).toBe('steered');
  });

  test('a late concern over its 1 nudge, after Esc, or after the nudge turn (in its cooldown) is held', () => {
    expect(routeNote('concern', { ...IDLE, nudges: 1 })).toBe('held');
    expect(routeNote('concern', { ...IDLE, isAfterEsc: true })).toBe('held');
    // The counter is still at the nudge turn: it cools down also with immuneTurns 0.
    expect(routeNote('concern', { ...IDLE, nudgeTurn: 4, immuneTurns: 0 })).toBe('held');
  });

  test('a late blocker has a budget of 2 nudges of its own: a spent concern nudge and a nudge turn leave it one', () => {
    expect(routeNote('blocker', { ...IDLE, nudges: 1, nudgeTurn: 4 })).toBe('nudge pending');
    expect(routeNote('blocker', { ...IDLE, blockerNudges: 1, nudgeTurn: 4 })).toBe('nudge pending');
    expect(routeNote('blocker', { ...IDLE, blockerNudges: 2 })).toBe('held');
    expect(routeNote('blocker', { ...IDLE, isAfterEsc: true })).toBe('held');
  });

  test('a nudge that carries a blocker takes the blocker budget; a nudge of concerns alone the concern budget', () => {
    expect(budgetOf([{ severity: 'concern' }, { severity: 'blocker' }])).toBe('blockerNudges');
    expect(budgetOf([{ severity: 'concern' }, { severity: 'concern' }])).toBe('nudges');
  });

  test('the cooldown holds a late concern for immuneTurns main turns after the nudge turn; a blocker is exempt', () => {
    // Nudge turn 2: turns 2 to 5 cool down with immuneTurns 3, turn 6 does not.
    const cooled = { ...IDLE, nudgeTurn: 2 };
    expect(routeNote('concern', { ...cooled, turn: 5 })).toBe('held');
    expect(routeNote('blocker', { ...cooled, turn: 5 })).toBe('nudge pending');
    expect(routeNote('concern', { ...cooled, turn: 6 })).toBe('nudge pending');
    expect(routeNote('concern', { ...cooled, turn: 2, immuneTurns: 0 })).toBe('held');
    expect(routeNote('concern', { ...cooled, turn: 3, immuneTurns: 0 })).toBe('nudge pending');
  });
});

describe('the budgets and the cooldown the status shows', () => {
  test('the main turns of the cooldown still to come; 0 before the first nudge', () => {
    expect(cooldownLeft(IDLE)).toBe(0);
    expect(cooldownLeft({ ...IDLE, turn: 2, nudgeTurn: 2 })).toBe(3);
    expect(cooldownLeft({ ...IDLE, turn: 4, nudgeTurn: 2 })).toBe(1);
    expect(cooldownLeft({ ...IDLE, turn: 9, nudgeTurn: 2 })).toBe(0);
  });

  test('the concern budget, the blocker budget and the cooldown, each as a part of the first line', () => {
    expect(nudgeStatus(IDLE)).toEqual(['nudge 0/1', 'blocker 0/2', 'cooldown 0']);
    expect(nudgeStatus({ ...IDLE, nudges: 1, blockerNudges: 2, nudgeTurn: 3 })).toEqual([
      'nudge 1/1',
      'blocker 2/2',
      'cooldown 2',
    ]);
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
