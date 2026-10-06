// One run folder for each probe session: <out>/runs/<name>/ with `proj/` (a git repo copied from fixtures/proj,
// the session's working folder) and `logs/`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, MODS_DIR } from './env.mjs';

const writeFiles = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    if (content === null) {
      fs.rmSync(target, { force: true, recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
  }
};

// `files` maps a path inside `proj/` to its text (an object is written as JSON), or to null to delete the fixture's
// file. `fixture` names a folder of fixtures/ (default `proj`).
export const createRun = (ctx, name, { fixture = 'proj', files = {} } = {}) => {
  let dir = path.join(ctx.outDir, 'runs', name);
  for (let i = 2; fs.existsSync(dir); i += 1) {
    dir = path.join(ctx.outDir, 'runs', `${name}-${i}`);
  }
  const proj = path.join(dir, 'proj');
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.cpSync(path.join(FIXTURES_DIR, fixture), proj, { recursive: true });
  writeFiles(proj, files);
  execFileSync('git', ['init', '-q', proj]);
  // The real path: Claude Code keys its transcripts by it (/tmp is /private/tmp on macOS).
  const real = fs.realpathSync(proj);
  const run = { name: path.basename(dir), dir, proj: real, logs, ctx };
  ctx.runs.push(run);
  return run;
};

export const writeProjectFiles = (run, files) => writeFiles(run.proj, files);

// Copies a probe mod of mods/<mod>/ into the run folder and fills its placeholders: `__DIR__` is the run folder,
// `__LOG__` the run's log folder, and each key of `fill` (for example `__MODE__`).
export const installMod = (run, mod, fill = {}) => {
  const target = path.join(run.dir, 'plugins', mod);
  fs.cpSync(path.join(MODS_DIR, mod), target, { recursive: true });
  const values = { __DIR__: run.dir, __LOG__: run.logs, ...fill };
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (/\.(m?js|ts|json|md)$/u.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        const filled = Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(key, String(value)), text);
        if (filled !== text) {
          fs.writeFileSync(file, filled);
        }
      }
    }
  };
  walk(target);
  return target;
};

export const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

export const readJsonLines = (file) =>
  readText(file)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
