import { describe, expect, test } from 'claude-code/testing';
import { asOnFlag, isEnvOnFlag, onStoreKey, pickOnFlag } from '../hooks/lifecycle/on-order';

const BY_COMMAND = { isOn: true, source: '/watchdog on' } as const;
const BY_DEFAULT = { isOn: true, source: 'onByDefault' } as const;
const BY_ENV = { isOn: true, source: 'CLAUDE_WATCHDOG' } as const;
const OFF = { isOn: false } as const;

describe('on flag values', () => {
  test('a stored value with lastUsed reads as its flag; other shapes read as no value', () => {
    expect(asOnFlag({ ...BY_COMMAND, lastUsed: 5 })).toEqual(BY_COMMAND);
    expect(asOnFlag({ isOn: false, lastUsed: 5 })).toEqual(OFF);
    expect(asOnFlag(undefined)).toBeUndefined();
    expect(asOnFlag({ isOn: true })).toBeUndefined();
    expect(asOnFlag({ isOn: true, source: 'elsewhere' })).toBeUndefined();
    expect(asOnFlag('on')).toBeUndefined();
  });

  test('only an on state from CLAUDE_WATCHDOG is an env flag', () => {
    expect(isEnvOnFlag(BY_ENV)).toBe(true);
    expect(isEnvOnFlag(BY_DEFAULT)).toBe(false);
    expect(isEnvOnFlag(OFF)).toBe(false);
  });

  test('the store key holds the session id', () => {
    expect(onStoreKey('s1')).toBe('on:s1');
  });
});

describe('on order', () => {
  const none = { state: undefined, stored: undefined, onByDefault: false, isInteractive: true, isEnvOn: false };

  test('the $.state flag wins over the stored flag and onByDefault, also a false', () => {
    expect(pickOnFlag({ ...none, state: OFF, stored: BY_COMMAND, onByDefault: true })).toEqual(OFF);
    expect(pickOnFlag({ ...none, state: BY_ENV, stored: OFF })).toEqual(BY_ENV);
  });

  test('the stored flag wins over onByDefault', () => {
    expect(pickOnFlag({ ...none, stored: OFF, onByDefault: true })).toEqual(OFF);
    expect(pickOnFlag({ ...none, stored: { ...BY_COMMAND, lastUsed: 1 } })).toEqual(BY_COMMAND);
  });

  test('onByDefault decides last', () => {
    expect(pickOnFlag({ ...none, onByDefault: true })).toEqual(BY_DEFAULT);
    expect(pickOnFlag(none)).toEqual(OFF);
  });

  test('a headless session uses only the $.state flag, then CLAUDE_WATCHDOG', () => {
    const headless = { ...none, isInteractive: false, stored: BY_COMMAND, onByDefault: true };
    expect(pickOnFlag(headless)).toBeUndefined();
    expect(pickOnFlag({ ...headless, state: BY_COMMAND })).toEqual(BY_COMMAND);
    expect(pickOnFlag({ ...headless, isEnvOn: true })).toEqual(BY_ENV);
    expect(pickOnFlag({ ...headless, state: OFF, isEnvOn: true })).toEqual(OFF);
  });

  test('an interactive session ignores CLAUDE_WATCHDOG', () => {
    expect(pickOnFlag({ ...none, isEnvOn: true })).toEqual(OFF);
  });
});
