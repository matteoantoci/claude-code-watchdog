import { describe, expect, test } from 'claude-code/testing';
import { forkDeny, guardDeny, toolDeny } from '../hooks/tools/guard';
import { normalizePath } from '../hooks/tools/paths';
import { addEntry, isScopedCheck, readScopeDeny, scopeKey, toolArguments } from '../hooks/tools/scope';

describe('path normalization', () => {
  test('`.`, `..`, repeated and trailing slashes resolve', () => {
    expect(normalizePath('/repo/./src/../lib//a.ts')).toBe('/repo/lib/a.ts');
    expect(normalizePath('/repo/lib/')).toBe('/repo/lib');
    expect(normalizePath('/repo/..')).toBe('/');
    expect(normalizePath('/')).toBe('/');
  });

  test('an absolute path that goes above `/` at any point has no normal form', () => {
    expect(normalizePath('/..')).toBeUndefined();
    expect(normalizePath('/../etc/passwd')).toBeUndefined();
    expect(normalizePath('/repo/../../etc/passwd')).toBeUndefined();
  });

  test('a relative path keeps its leading `..`', () => {
    expect(normalizePath('src/../../lib/./a.ts')).toBe('../lib/a.ts');
    expect(normalizePath('./src/..')).toBe('.');
  });
});

describe('the read-scope match rule', () => {
  test('a Read matches on its normalized file_path only', () => {
    const key = scopeKey('Read', { file_path: '/outside/lib/a.ts' });
    expect(scopeKey('Read', { file_path: '/outside/x/../lib/a.ts', offset: 10, limit: 5 })).toBe(key);
    expect(scopeKey('Read', { file_path: '/outside/lib/a.ts/' })).toBe(key);
  });

  test('no prefix match: a file under a recorded folder or path has its own key', () => {
    expect(scopeKey('Read', { file_path: '/outside/lib/b.ts' })).not.toBe(
      scopeKey('Read', { file_path: '/outside/lib' })
    );
    expect(scopeKey('Grep', { pattern: 'x', path: '/outside/lib/sub' })).not.toBe(
      scopeKey('Grep', { pattern: 'x', path: '/outside/lib' })
    );
  });

  test('a Grep or a Glob matches on its whole input, keys in any order, path normalized', () => {
    const key = scopeKey('Grep', { pattern: 'TODO', path: '/outside/lib', output_mode: 'content' });
    expect(scopeKey('Grep', { output_mode: 'content', path: '/outside/./lib/', pattern: 'TODO' })).toBe(key);
    expect(scopeKey('Grep', { pattern: 'TODO', path: '/outside/lib' })).not.toBe(key);
    expect(scopeKey('Glob', { pattern: 'TODO', path: '/outside/lib', output_mode: 'content' })).not.toBe(key);
  });

  test('a path above `/`, a missing path and every other tool match nothing', () => {
    expect(scopeKey('Read', { file_path: '/../etc/passwd' })).toBeUndefined();
    expect(scopeKey('Grep', { pattern: 'x', path: '/../etc' })).toBeUndefined();
    expect(scopeKey('Read', {})).toBeUndefined();
    expect(scopeKey('Read', 'not an object')).toBeUndefined();
    expect(scopeKey('mcp__docs__search', { query: 'x' })).toBeUndefined();
  });

  test('a tool.call keeps only the tool arguments, as tool.check gives them', () => {
    const call = { tool: 'Read', tool_use_id: 'toolu_1', agentId: 'a1', file_path: '/x', limit: 3 };
    expect(toolArguments(call)).toEqual({ file_path: '/x', limit: 3 });
  });

  test('the deny names the path, else the pattern, else the tool', () => {
    expect(readScopeDeny('Read', { file_path: '/etc/hosts' })).toBe(
      'Outside the watchdog read scope: /etc/hosts. Do not retry this path. Review with what you have.'
    );
    expect(readScopeDeny('Glob', { pattern: '/etc/**' })).toMatch(/scope: \/etc\/\*\*\./u);
    expect(readScopeDeny('mcp__docs__search', { query: 'x' })).toMatch(/scope: mcp__docs__search\./u);
  });
});

describe('the allow set', () => {
  test('a key enters once as the newest, and past the cap the oldest goes out', () => {
    expect(addEntry(['a', 'b'], 'a', 3)).toEqual(['b', 'a']);
    expect(addEntry(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });

  test('the cap is 500', () => {
    const full = Array.from({ length: 500 }, (_entry, index) => `Read /f${index}`);
    const next = addEntry(full, 'Read /new');
    expect(next.length).toBe(full.length);
    expect(next[0]).toBe('Read /f1');
    expect(next.at(-1)).toBe('Read /new');
  });
});

describe('which checks the read scope acts on', () => {
  test('a call the watchdog plugin raised or a review agent made, except Agent, SendMessage, TaskStop', () => {
    expect(isScopedCheck('Read', 'watchdog', false)).toBe(true);
    expect(isScopedCheck('mcp__docs__search', 'engine', true)).toBe(true);
    expect(isScopedCheck('Read', 'engine', false)).toBe(false);
    expect(isScopedCheck('Read', 'other', false)).toBe(false);
    for (const tool of ['Agent', 'SendMessage', 'TaskStop']) {
      expect(isScopedCheck(tool, 'watchdog', true)).toBe(false);
    }
  });
});

describe('the tool.call guard', () => {
  const tools = ['Read', 'Grep', 'Glob'];

  test('a review agent runs its own tools and note, and nothing else', () => {
    expect(guardDeny('Read', tools, true)).toBeUndefined();
    expect(guardDeny('mcp__watchdog__note', tools, true)).toBeUndefined();
    expect(guardDeny('Bash', tools, true)).toBe(toolDeny('Bash'));
    expect(guardDeny('Edit', [], true)).toBe(toolDeny('Edit'));
  });

  test('another loop the watchdog plugin raised is a fork and runs nothing', () => {
    expect(guardDeny('Read', undefined, true)).toBe(forkDeny);
    expect(guardDeny('mcp__watchdog__note', undefined, true)).toBe(forkDeny);
  });

  test('a loop of the primary agent or of another plugin passes', () => {
    expect(guardDeny('Bash', undefined, false)).toBeUndefined();
  });
});
