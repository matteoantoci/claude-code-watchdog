import { describe, expect, test } from 'claude-code/testing';
import { classifyError, classifySpawnError, isSameModel, spawnOutcome } from '../hooks/failure/classify';
import { AUTO_MODE_DENY } from './fixtures/engine/auto-mode-deny';

// The row texts of spec §12.2, as the agent's synthetic `session.append` row holds them.
describe('§12.2 classification by text', () => {
  test('each row of the text table gives its class', () => {
    const rows: [string, string][] = [
      ["You've hit your limit · resets 3pm (Europe/Rome)", 'limit'],
      ['Credit balance is too low', 'billing'],
      ['Prompt is too long · the request is ~375704 tokens (limit 200000)', 'too_long'],
      ["There's an issue with the selected model (claude-nonexistent-9). It may not exist.", 'no_model'],
      ['API Error: 529 Overloaded. This is a server-side issue, usually temporary.', 'overload'],
      ['Repeated 529 Overloaded errors', 'overload'],
      ['Server is temporarily limiting requests', 'overload'],
      ['API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', 'gateway'],
      ['API Error: 400 Your credit balance is low on this workspace', 'other'],
      ['Something nobody wrote down', 'unmatched'],
    ];
    for (const [text, kind] of rows) {
      expect(classifyError(text)).toBe(kind);
    }
  });

  test('the word "limit" alone is not a subscription limit', () => {
    expect(classifyError('API Error: 400 output token limit exceeded')).toBe('other');
    expect(classifyError('rate limit')).toBe('unmatched');
  });
});

describe('§12.2 spawn errors', () => {
  test('only the two permission texts give blocked', () => {
    expect(classifySpawnError('watchdog: $.tool.call: no tool named "Agent" in this session')).toBe('blocked');
    expect(
      classifySpawnError(
        "Agent type 'watchdog:default' has been denied by permission rule 'Agent(watchdog:default)' from projectSettings."
      )
    ).toBe('blocked');
    expect(classifySpawnError("Agent type 'other:x' has been denied by permission rule 'Agent(other:x)'.")).toBe(
      'failed'
    );
  });

  test('the plugin cap and the session cap texts count no failure', () => {
    expect(classifySpawnError('watchdog: $.agent.spawn refused: 20 spawns are running at once')).toBe('capped');
    expect(
      classifySpawnError('Concurrent subagent limit reached. You can run 1 subagents at once. Do not retry.')
    ).toBe('capped');
  });

  test('any other reject or deny counts one failure', () => {
    expect(classifySpawnError('<tool_use_error>InputValidationError: model')).toBe('failed');
    expect(classifySpawnError('no session is bound in this process')).toBe('failed');
  });

  test('an auto-mode classifier text, in any case, is blocked by auto mode and counts no failure', () => {
    expect(classifySpawnError(AUTO_MODE_DENY)).toBe('auto_mode');
    expect(classifySpawnError('the Auto Mode Classifier judged this action dangerous')).toBe('auto_mode');
    expect(spawnOutcome(AUTO_MODE_DENY)).toEqual({ kind: 'blocked', error: 'auto mode' });
    expect(spawnOutcome('no session is bound in this process')).toEqual({
      kind: 'failed',
      error: 'no session is bound in this process',
    });
  });
});

describe('§12.2 model compare', () => {
  test('a roster alias matches any model of its family', () => {
    expect(isSameModel('opus', 'claude-opus-4-5')).toBe(true);
    expect(isSameModel('sonnet', 'claude-sonnet-5-5')).toBe(true);
    expect(isSameModel('opus', 'claude-sonnet-5-5')).toBe(false);
  });

  test('a full roster id matches only an equal id', () => {
    expect(isSameModel('claude-opus-4-5', 'claude-opus-4-5')).toBe(true);
    expect(isSameModel('claude-opus-4-5', 'claude-opus-4-5-20251101')).toBe(false);
  });
});
