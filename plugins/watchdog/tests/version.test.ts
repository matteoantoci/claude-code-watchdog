import { describe, expect, test } from 'claude-code/testing';
import { isSupportedVersion } from '../hooks/lifecycle/version';

describe('version gate compare', () => {
  test('the minimum release is supported', () => {
    expect(isSupportedVersion('2.1.290')).toBe(true);
  });

  test('a release below the minimum is unsupported', () => {
    expect(isSupportedVersion('2.1.289')).toBe(false);
    expect(isSupportedVersion('2.0.999')).toBe(false);
    expect(isSupportedVersion('1.9.300')).toBe(false);
  });

  test('a later release is supported, also with a lower patch or minor', () => {
    expect(isSupportedVersion('2.1.291')).toBe(true);
    expect(isSupportedVersion('2.2.0')).toBe(true);
    expect(isSupportedVersion('3.0.0')).toBe(true);
  });

  test('parts compare as numbers, not as text', () => {
    expect(isSupportedVersion('2.1.1000')).toBe(true);
    expect(isSupportedVersion('2.1.29')).toBe(false);
  });

  test('a -dev suffix counts as its release', () => {
    expect(isSupportedVersion('2.1.290-dev')).toBe(true);
    expect(isSupportedVersion('2.1.289-dev')).toBe(false);
  });

  test('an absent base counts as supported', () => {
    expect(isSupportedVersion(undefined)).toBe(true);
  });
});
