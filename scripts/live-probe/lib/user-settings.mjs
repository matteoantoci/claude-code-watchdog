// §16.3: a `userConfig` reload probe writes ~/.claude/settings.json (through `$.config.set`, or an outside edit).
// Back it up first and restore it in the same run, byte for byte, also on Ctrl-C (probe.mjs calls ctx.restores).
import fs from 'node:fs';
import path from 'node:path';
import { USER_SETTINGS } from './env.mjs';

export const readUserSettings = () => JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'));

export const writeUserSettings = (settings) =>
  fs.writeFileSync(USER_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

// Runs `fn()` with a backup of the user settings in <run>/logs/settings.json.backup; restores it after, and checks
// the restore. Resolves fn's value; rejects when the restore does not match the backup.
export const withUserSettings = async (run, fn) => {
  const backup = path.join(run.logs, 'settings.json.backup');
  const original = fs.readFileSync(USER_SETTINGS);
  fs.writeFileSync(backup, original);
  const restore = () => {
    fs.writeFileSync(USER_SETTINGS, original);
  };
  run.ctx.restores.add(restore);
  try {
    return await fn();
  } finally {
    restore();
    run.ctx.restores.delete(restore);
    if (!fs.readFileSync(USER_SETTINGS).equals(original)) {
      throw new Error(`~/.claude/settings.json differs from its backup ${backup}`);
    }
  }
};

// The enabled plugins of the user settings, each set to false: a project settings.local.json with this map keeps
// the person's plugins out of a session that reads user settings (prototypes/first-checks/reload/proj).
export const userPluginsOff = () =>
  Object.fromEntries(Object.keys(readUserSettings().enabledPlugins ?? {}).map((key) => [key, false]));

// `pluginConfigs["watchdog@inline"].options` of the user settings: where a `--plugin-dir` plugin's userConfig lives.
export const INLINE_KEY = 'watchdog@inline';
