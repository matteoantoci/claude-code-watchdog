// The §16.3 probe setup: the cached Claude Code binary by its full path, the environment of every probe session and
// the setting sources.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROBE_DIR = path.resolve(import.meta.dirname, '..');
export const REPO_DIR = path.resolve(PROBE_DIR, '../..');
export const PLUGIN_DIR = path.join(REPO_DIR, 'plugins/watchdog');
export const FIXTURES_DIR = path.join(PROBE_DIR, 'fixtures');
export const MODS_DIR = path.join(PROBE_DIR, 'mods');
export const HOME = os.homedir();
export const CLAUDE_HOME = path.join(HOME, '.claude');
export const USER_SETTINGS = path.join(CLAUDE_HOME, 'settings.json');

// §3, §16.3: the minimum and pinned Claude Code version.
export const PINNED_VERSION = '2.1.290';

// §16.3: `~/.cache/claude-code-<version>/node_modules/.bin/claude`, never a bare `claude` from PATH.
export const claudeBin = (version) => path.join(HOME, `.cache/claude-code-${version}/node_modules/.bin/claude`);

// §16.3: `--setting-sources project,local` on this machine (the user `permissions.deny` lists `SendMessage`); a
// `userConfig` reload probe needs `user,project,local`.
export const SETTING_SOURCES = 'project,local';
export const SETTING_SOURCES_WITH_USER = 'user,project,local';

// The policy tier takes its settings from the first source that has any: server-managed settings (an org pushes them
// to `remote-settings.json`), then an admin `managed-settings.json`, then the `--managed-settings` JSON of a parent
// process. So with either file present, a probe's `--managed-settings` applies nothing. Returns that file or null.
const MANAGED_TIERS = [
  path.join(CLAUDE_HOME, 'remote-settings.json'),
  '/Library/Application Support/ClaudeCode/managed-settings.json',
];

export const managedTier = () => MANAGED_TIERS.find((file) => fs.existsSync(file)) ?? null;

// Variables a parent Claude Code or the person's shell may carry that change a probe session.
const DROPPED = [
  'NO_COLOR',
  'CI',
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_WATCHDOG',
  'WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'ENABLE_TOOL_SEARCH',
];

// §16.3: `env -u NO_COLOR -u CI TERM=xterm-256color`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
// `extra` adds variables; a value of undefined removes one.
export const probeEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const name of DROPPED) {
    delete env[name];
  }
  Object.assign(env, { TERM: 'xterm-256color', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = String(value);
    }
  }
  return env;
};

// The binary must exist and answer the expected version, else no check can run.
export const checkBinary = (bin, version) => {
  if (!fs.existsSync(bin)) {
    return {
      ok: false,
      text: `${bin} is missing. Install it: mkdir -p ~/.cache/claude-code-${version} && cd ~/.cache/claude-code-${version} && npm install @anthropic-ai/claude-code@${version} && node node_modules/@anthropic-ai/claude-code/install.cjs`,
    };
  }
  const out = execFileSync(bin, ['--version'], { env: probeEnv(), encoding: 'utf8' }).trim();
  return out.startsWith(`${version} `) || out === version
    ? { ok: true, text: out }
    : { ok: false, text: `${bin} --version answered "${out}", expected ${version}` };
};

export const hasTmux = () => {
  try {
    execFileSync('tmux', ['-V'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
