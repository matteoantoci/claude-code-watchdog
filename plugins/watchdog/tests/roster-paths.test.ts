import { describe, expect, test } from 'claude-code/testing';
import { displayPath, searchPaths } from '../hooks/roster/paths';

const IN_GIT = {
  configDir: undefined,
  home: '/home/me',
  gitRoot: '/home/me/repo',
  cwd: '/home/me/repo/pkg/app',
  root: '/home/me/repo',
};

describe('WATCHDOG.json search paths (§4.3)', () => {
  test('the user file first, then .claude/ and the plain file of each directory from the git root down to the cwd', () => {
    expect(searchPaths(IN_GIT, 'WATCHDOG.json')).toEqual([
      { path: '/home/me/.claude/WATCHDOG.json', isUser: true },
      { path: '/home/me/repo/.claude/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/pkg/.claude/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/pkg/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/pkg/app/.claude/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/pkg/app/WATCHDOG.json', isUser: false },
    ]);
  });

  test('CLAUDE_CONFIG_DIR replaces $HOME/.claude for the user file', () => {
    const paths = searchPaths({ ...IN_GIT, configDir: '/etc/claude/' }, 'WATCHDOG.json');
    expect(paths[0]).toEqual({ path: '/etc/claude/WATCHDOG.json', isUser: true });
  });

  test('outside git, the project files are the two files of the session root', () => {
    const where = { ...IN_GIT, gitRoot: null, cwd: '/work/a/b', root: '/work/a' };
    expect(searchPaths(where, 'WATCHDOG.json')).toEqual([
      { path: '/home/me/.claude/WATCHDOG.json', isUser: true },
      { path: '/work/a/.claude/WATCHDOG.json', isUser: false },
      { path: '/work/a/WATCHDOG.json', isUser: false },
    ]);
  });

  test('a git root at $HOME loads the user file once, as the user file', () => {
    const where = { ...IN_GIT, gitRoot: '/home/me', cwd: '/home/me', root: '/home/me' };
    expect(searchPaths(where, 'WATCHDOG.json')).toEqual([
      { path: '/home/me/.claude/WATCHDOG.json', isUser: true },
      { path: '/home/me/WATCHDOG.json', isUser: false },
    ]);
  });

  test('the skip compares normalized paths: a trailing slash or a dot segment still matches', () => {
    const where = {
      ...IN_GIT,
      configDir: '/home/me/./.claude/',
      gitRoot: '/home/me/',
      cwd: '/home/me',
      root: '/home/me',
    };
    expect(searchPaths(where, 'WATCHDOG.json').map((file) => file.path)).toEqual([
      '/home/me/.claude/WATCHDOG.json',
      '/home/me/WATCHDOG.json',
    ]);
  });

  test('with no CLAUDE_CONFIG_DIR and no HOME there is no user file', () => {
    const where = { ...IN_GIT, home: undefined, cwd: '/home/me/repo' };
    expect(searchPaths(where, 'WATCHDOG.json')).toEqual([
      { path: '/home/me/repo/.claude/WATCHDOG.json', isUser: false },
      { path: '/home/me/repo/WATCHDOG.json', isUser: false },
    ]);
  });
});

describe('file labels in the status and the warnings', () => {
  test('a file under the cwd shows as ./, another file under $HOME as ~/, any other file in full', () => {
    expect(displayPath('/home/me/repo/pkg/app/WATCHDOG.json', IN_GIT)).toBe('./WATCHDOG.json');
    expect(displayPath('/home/me/repo/pkg/app/.claude/WATCHDOG.json', IN_GIT)).toBe('./.claude/WATCHDOG.json');
    expect(displayPath('/home/me/.claude/WATCHDOG.json', IN_GIT)).toBe('~/.claude/WATCHDOG.json');
    expect(displayPath('/etc/claude/WATCHDOG.json', IN_GIT)).toBe('/etc/claude/WATCHDOG.json');
  });
});
