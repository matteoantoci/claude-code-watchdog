#!/usr/bin/env node
// L3 live probe of the watchdog plugin (spec §16.3). Run it by hand before each release and before each bump of the
// pinned Claude Code version, on a real model and login. See README.md in this folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CHECKS, SCENARIOS } from './checks/index.mjs';
import { PINNED_VERSION, PLUGIN_DIR, REPO_DIR, checkBinary, claudeBin, hasTmux } from './lib/env.mjs';
import { sweepDumps } from './lib/files.mjs';
import { isFailedRun, summaryText, unavailableChecks, unavailableText, writeReport } from './lib/report.mjs';
import { killTmuxServer } from './lib/tui.mjs';

const USAGE = `usage: node scripts/live-probe/probe.mjs [options]
  --list                 list the checks and scenarios, run nothing
  --only <ids>           comma list of check ids, scenario ids or id prefixes (fc, l3, r-)
  --skip <ids>           the same, to leave out
  --kind <kind>          only deterministic or only advisory checks
  --with <caps>          opt-in capabilities: account:limit, account:billing, account:api-key, org:ceiling, org:managed
  --no-user-settings     skip the checks that write ~/.claude/settings.json (backed up and restored otherwise)
  --claude-version <v>   run ~/.cache/claude-code-<v>/node_modules/.bin/claude (default ${PINNED_VERSION})
  --out <dir>            report folder (default /tmp/wd-live-probe/<time>)`;

const OPT_IN = ['account:limit', 'account:billing', 'account:api-key', 'org:ceiling', 'org:managed'];

const parse = () =>
  parseArgs({
    options: {
      list: { type: 'boolean', default: false },
      only: { type: 'string' },
      skip: { type: 'string' },
      kind: { type: 'string' },
      with: { type: 'string' },
      'no-user-settings': { type: 'boolean', default: false },
      'claude-version': { type: 'string', default: PINNED_VERSION },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }).values;

const tokens = (text) =>
  text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const matches = (list, check) =>
  list.some((token) => check.id === token || check.scenario === token || check.id.startsWith(token));

const stamp = () => new Date().toISOString().replaceAll(/[-:]/gu, '').replace('T', '-').slice(0, 15);

// The capabilities that come from a tool on this machine, not from an option.
const MACHINE = { tui: 'tmux' };

// Why a check does not run: a capability it needs is off, or it is a manual check. `unavailable` lists the needs this
// machine lacks when no option turned off the check too; such a skipped deterministic check fails the run (§16.3).
const skipReason = (check, caps) => {
  if (check.kind === 'manual') {
    return { reason: 'manual: see the Desktop checklist in scripts/live-probe/README.md', unavailable: [] };
  }
  const scenario = SCENARIOS.get(check.scenario);
  const needs = [...(check.needs ?? []), ...(scenario?.needs ?? [])];
  const missing = needs.filter((need) => !caps.has(need));
  if (missing.length === 0) {
    return null;
  }
  const tools = missing.filter((need) => Object.hasOwn(MACHINE, need)).map((need) => MACHINE[need]);
  const hints = [
    ...(missing.some((need) => OPT_IN.includes(need)) ? ['opt in with --with'] : []),
    ...(tools.length > 0 ? [`${tools.join(', ')} not found on this machine`] : []),
  ];
  return {
    reason: `needs ${missing.join(', ')}${hints.length > 0 ? ` (${hints.join('; ')})` : ''}`,
    unavailable: tools.length === missing.length ? missing.map((need) => `${need} (${MACHINE[need]})`) : [],
  };
};

const selected = (check, opts) => {
  const only = tokens(opts.only);
  const skip = tokens(opts.skip);
  return (
    (only.length === 0 || matches(only, check)) &&
    !matches(skip, check) &&
    (!opts.kind || check.kind === opts.kind || check.kind === 'manual')
  );
};

const listChecks = () => {
  for (const check of CHECKS) {
    console.log(
      `${check.id.padEnd(34)} ${check.kind.padEnd(13)} ${(check.scenario ?? '-').padEnd(26)} ${check.source}`
    );
  }
};

const cleanup = (ctx) => {
  for (const restore of ctx.restores) {
    restore();
  }
  ctx.restores.clear();
  for (const child of ctx.children) {
    child.kill('SIGTERM');
  }
  ctx.children.clear();
  killTmuxServer();
};

// Each probe session writes the plugin's generated `.claude-plugin/types/` again for its own settings, and those
// files are committed (spec §2). Snapshot them before the run; the restore puts back each file that changed.
const keepTypes = () => {
  const dir = path.join(PLUGIN_DIR, '.claude-plugin', 'types');
  const files = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((file) => [file, fs.readFileSync(file)]);
  return () => {
    for (const [file, bytes] of files) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) {
        fs.writeFileSync(file, bytes);
      }
    }
  };
};

const runScenario = async (ctx, scenario) => {
  const before = ctx.runs.length;
  const started = Date.now();
  console.log(`\n▶ scenario ${scenario.id}: ${scenario.title}`);
  try {
    const obs = await scenario.run(ctx);
    return { obs, error: null, runs: ctx.runs.slice(before).map((run) => run.dir), ms: Date.now() - started };
  } catch (error) {
    console.log(`  scenario error: ${error?.stack ?? error}`);
    return {
      obs: null,
      error: String(error?.stack ?? error),
      runs: ctx.runs.slice(before).map((run) => run.dir),
      ms: Date.now() - started,
    };
  } finally {
    // A dump of a probe session that its scenario did not collect goes into that run's logs, not the person's.
    for (const run of ctx.runs.slice(before)) {
      sweepDumps(run);
    }
  }
};

const verifyCheck = async (check, outcome, ctx) => {
  const base = { id: check.id, title: check.title, kind: check.kind, source: check.source, scenario: check.scenario };
  if (outcome.error) {
    return {
      ...base,
      status: 'error',
      reason: 'the scenario failed',
      evidence: [outcome.error.split('\n')[0]],
      runs: outcome.runs,
    };
  }
  try {
    const verdict = await check.verify(outcome.obs, ctx);
    return { ...base, ...verdict, runs: outcome.runs };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      reason: 'verify threw',
      evidence: [String(error?.stack ?? error)],
      runs: outcome.runs,
    };
  }
};

const main = async () => {
  const opts = parse();
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.list) {
    listChecks();
    return 0;
  }
  const bin = claudeBin(opts['claude-version']);
  const binary = checkBinary(bin, opts['claude-version']);
  if (!binary.ok) {
    console.error(binary.text);
    return 2;
  }
  const outDir = path.resolve(opts.out ?? `/tmp/wd-live-probe/${stamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const caps = new Set(['proxy', ...tokens(opts.with)]);
  if (hasTmux()) {
    caps.add('tui');
  }
  if (!opts['no-user-settings']) {
    caps.add('user-settings');
  }
  const ctx = {
    started: Date.now(),
    finished: null,
    outDir,
    bin,
    version: opts['claude-version'],
    versionText: binary.text,
    pluginDir: PLUGIN_DIR,
    commit: execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    argvText: process.argv.slice(2).join(' ') || '(none)',
    caps,
    runs: [],
    children: new Set(),
    tmuxSessions: new Set(),
    restores: new Set(),
  };
  ctx.restores.add(keepTypes());
  process.on('SIGINT', () => {
    cleanup(ctx);
    process.exit(130);
  });
  const chosen = CHECKS.filter((check) => selected(check, opts));
  const results = [];
  const toRun = [];
  for (const check of chosen) {
    const skip = skipReason(check, caps);
    if (skip) {
      results.push({
        id: check.id,
        title: check.title,
        kind: check.kind,
        source: check.source,
        scenario: check.scenario ?? null,
        status: check.kind === 'manual' ? 'manual' : 'skipped',
        reason: skip.reason,
        ...(skip.unavailable.length > 0 ? { unavailable: skip.unavailable } : {}),
        evidence: check.manual ?? [],
      });
    } else {
      toRun.push(check);
    }
  }
  console.log(`claude: ${bin} (${binary.text}); report: ${path.join(outDir, 'report.md')}`);
  console.log(`checks: ${toRun.length} to run, ${results.length} skipped or manual`);
  if (unavailableChecks(results).length > 0) {
    console.log(`${unavailableText(results)}\nthe run will fail: install the missing tools and run again`);
  }
  const order = [...SCENARIOS.keys()].filter((id) => toRun.some((check) => check.scenario === id));
  try {
    for (const id of order) {
      const outcome = await runScenario(ctx, SCENARIOS.get(id));
      for (const check of toRun.filter((item) => item.scenario === id)) {
        const result = await verifyCheck(check, outcome, ctx);
        console.log(`  ${result.status.padEnd(12)} ${check.kind.padEnd(13)} ${check.id}`);
        results.push(result);
      }
      writeReport(ctx, results);
    }
  } finally {
    cleanup(ctx);
  }
  ctx.finished = Date.now();
  const report = writeReport(ctx, results);
  console.log(`\n${summaryText(results)}\nreport: ${report}`);
  return isFailedRun(results) ? 1 : 0;
};

process.exitCode = await main();
