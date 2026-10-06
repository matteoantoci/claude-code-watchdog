import { describe, expect, test } from 'claude-code/testing';
import { troubleLine } from '../hooks/band/problems';
import type { Trouble } from '../hooks/band/problems';

const NOW = 1_000_000;

const MINUTE = 60_000;

const halted = (name: string, minutes: number): Trouble => ({
  name,
  problem: { state: 'halted', reason: 'Overloaded', tries: 1, nextTryAt: NOW + minutes * MINUTE },
});

const noModel = (name: string): Trouble => ({ name, problem: { state: 'no_model', reason: 'unknown model' } });

const WIDE = { now: NOW, columns: 115, isAlone: false };

describe('failure line (§12.5)', () => {
  test('no watchdog in trouble: no line', () => {
    expect(troubleLine([], WIDE)).toBeUndefined();
  });

  test('several: the most serious state first, one short part for each, then /watchdog status', () => {
    expect(troubleLine([halted('security', 12), noModel('default')], WIDE)).toBe(
      'watchdog: default no_model · security halted · retry in 12 min · /watchdog status'
    );
    const limited: Trouble = { name: 'perf', problem: { state: 'limited', reason: 'limit' } };
    const blocked: Trouble = { name: 'style', problem: { state: 'blocked', reason: 'Agent denied' } };
    expect(troubleLine([limited, halted('security', 12), blocked], WIDE)).toBe(
      'watchdog: style blocked · security halted · retry in 12 min · perf limited · /watchdog status'
    );
  });

  test('the only watchdog halted: its retry and /watchdog on', () => {
    expect(troubleLine([halted('default', 12)], { ...WIDE, isAlone: true })).toBe(
      'watchdog halted · retry in 12 min · /watchdog on to retry now'
    );
  });

  test('one of several halted names itself; a passed next try waits for the next prompt', () => {
    expect(troubleLine([halted('security', 0)], WIDE)).toBe(
      'watchdog: security halted · retry at the next prompt · /watchdog on to retry now'
    );
  });

  test('one watchdog with no model: fix WATCHDOG.json, then /watchdog on', () => {
    expect(troubleLine([noModel('security')], { ...WIDE, isAlone: true })).toBe(
      'watchdog: security no_model · fix WATCHDOG.json, then /watchdog on'
    );
  });

  test('below 80 bodyColumns the line counts the watchdogs in trouble', () => {
    expect(troubleLine([halted('security', 12), noModel('default')], { ...WIDE, columns: 75 })).toBe(
      'watchdog: 2 problems · /watchdog status'
    );
  });
});
