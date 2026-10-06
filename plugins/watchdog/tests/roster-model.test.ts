import { describe, expect, test } from 'claude-code/testing';
import { parseModel, resolveEffort } from '../hooks/roster/model';

describe('roster model string (§6.2)', () => {
  test('an alias or a full id with no provider passes unchanged, with no level', () => {
    expect(parseModel('sonnet')).toEqual({ kind: 'model', model: 'sonnet', level: undefined });
    expect(parseModel('claude-opus-4-5')).toEqual({ kind: 'model', model: 'claude-opus-4-5', level: undefined });
  });

  test('the provider anthropic is dropped and :level gives the effort', () => {
    expect(parseModel('anthropic/claude-sonnet-4-5:high')).toEqual({
      kind: 'model',
      model: 'claude-sonnet-4-5',
      level: 'high',
    });
    expect(parseModel('opus:auto')).toEqual({ kind: 'model', model: 'opus', level: 'auto' });
  });

  test('another provider gives no_model with a reason', () => {
    expect(parseModel('openai/gpt-5')).toEqual({
      kind: 'no_model',
      reason: 'provider "openai" is not supported; only anthropic works now',
    });
  });

  test('an unknown :level or an empty id gives no_model with a reason', () => {
    expect(parseModel('opus:extreme')).toEqual({ kind: 'no_model', reason: 'unknown effort level "extreme"' });
    expect(parseModel('anthropic/')).toEqual({ kind: 'no_model', reason: 'no model id in "anthropic/"' });
  });

  test('inherit, with or without the provider, is its own case', () => {
    expect(parseModel('inherit')).toEqual({ kind: 'inherit' });
    expect(parseModel('anthropic/inherit:low')).toEqual({ kind: 'inherit' });
  });
});

describe(':auto effort (§6.2)', () => {
  test('auto takes the session effort, else medium', () => {
    expect(resolveEffort('auto', 'xhigh')).toBe('xhigh');
    expect(resolveEffort('auto', undefined)).toBe('medium');
  });

  test('a fixed level ignores the session effort', () => {
    expect(resolveEffort('low', 'max')).toBe('low');
  });
});
