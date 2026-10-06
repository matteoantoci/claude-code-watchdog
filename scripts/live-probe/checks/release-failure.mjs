// §16.5 release-probe items of the failure area (spec §12): the model compare (`fable`, the `availableModels`
// step-down, a managed `availableModels`), the failure rows that need a real account (gated with `--with`), and
// the engine retry behavior that the mod does not implement (research/smoke-review-failures.md:255-263). Engine
// texts and numbers below are from the 2.1.290 binary: retries `Bir=10`, clamp `Rqe=15` with the debug warn
// `CLAUDE_CODE_MAX_RETRIES=<n> clamped to 15`, the wait `min(32000, 500 * 2^(attempt-1))` plus up to 25 % jitter,
// a retry-after past `Qir=60000` ms ends the retries, and 3 (`a5`) 529s in a row end an Opus request of an account
// that is no claude.ai subscriber with `Repeated 529 Overloaded errors`, or switch to `fallbackModel` when one is set.
import path from 'node:path';
import { managedTier, sleep } from '../lib/env.mjs';
import { collectDumps, dumpReviews } from '../lib/files.mjs';
import { pluginDirs, runHeadless } from '../lib/headless.mjs';
import {
  agentTurnCompletes,
  mainTurnCompletes,
  noteCalls,
  ofEvent,
  readObs,
  reviewsDone,
  waitObs,
  watchdogSpawns,
} from '../lib/observe.mjs';
import { startProxy } from '../lib/proxy-ctl.mjs';
import { createRun, readText } from '../lib/run.mjs';
import { startTui } from '../lib/tui.mjs';
import { clip, expectAll, fail, inconclusive, pass } from '../lib/verdict.mjs';

const SHORT = 'Reply with the single word OK.';
const NOTE_ONLY =
  'This is a live probe. Call note once with severity nit and a one-line text that starts with WDPROBE, then end ' +
  'the review with done.';

// §12.2: the row texts the plugin classifies.
const LIMIT_PHRASE = "You've hit your limit";
const BILLING_PHRASE = 'Credit balance is too low';
const TOO_LONG_PHRASE = 'Prompt is too long';
const OPUS_PHRASE = 'Repeated 529 Overloaded errors';
const OVERLOAD_PHRASE = 'API Error: 529 Overloaded';

// The 2.1.290 debug-file warnings (`[WARN] …`) of the retry clamp and of a subagent model the allowlist blocks.
const CLAMP_LINE = /CLAUDE_CODE_MAX_RETRIES=20 clamped to 15/u;
const ALLOWLIST_LINE = /Subagent model "[^"]+" is not in the availableModels allowlist/u;

// §12.2 step-down: the allowlist keeps the haiku main loop and one older sonnet, so the `sonnet` alias
// (claude-sonnet-5-5 on 2.1.290) is blocked and its family's newest allowed model is claude-sonnet-4-6.
const STEP_DOWN_ALLOW = { availableModels: ['haiku', 'claude-sonnet-4-6'] };
const STEP_DOWN_TARGET = 'claude-sonnet-4-6';

// The probe mod `rf-model` (plugin `rfmodel`) registers this agent type.
const MODEL_TYPE = 'rfmodel:probe';

// The engine's retry numbers (see the header). 8 retries reach attempt 8, whose uncapped wait would be 64 s.
const BASE_MS = 500;
const CAP_MS = 32_000;
const JITTER = 0.25;
const COUNT_RETRIES = 8;

// The prompt that `/tasks` and `ctrl+x ctrl+k` start when the person stops a review (§12.1, agents/spec.ts).
const STOPPED_PROMPT = /Background agent "watchdog probe review" was stopped by the user\./u;

const roster = (model, { tools = [], instructions = NOTE_ONLY } = {}) => ({
  instructions,
  watchdogs: [{ name: 'probe', model, effort: 'low', tools }],
});

const uiLogs = (events) => ofEvent(events, 'ui.log').map((event) => String(event.text ?? ''));

// §12.5: the row of the watchdog `probe` going into a problem state: `watchdog: probe <state>: <error text>`.
const stateRow = (events, state) =>
  uiLogs(events).find((text) => text.startsWith(`watchdog: probe ${state}: `)) ?? null;

const problemRows = (events) =>
  uiLogs(events).filter((text) => /^watchdog: probe (?:limited|halted|no_model|blocked): /u.test(text));

// §12.1: the synthetic rows (`origin.model === "<synthetic>"`) that hold an agent's error text.
const syntheticTexts = (events, agentId) =>
  ofEvent(
    events,
    'session.append',
    (event) => event.agentId === agentId && event.origin?.kind === 'model' && event.origin?.model === '<synthetic>'
  ).map((event) => String(event.text ?? ''));

const debugLines = (file, pattern) =>
  readText(file)
    .split('\n')
    .filter((line) => pattern.test(line));

const dumpText = (dumps) => (dumps ?? []).map((dump) => dump.text).join('\n');

// The proxy log rows of the watchdog agent's model requests: the first line of each request (it has `url`).
const agentRequests = (log) =>
  log.filter(
    (row) =>
      row.who === 'agent' && String(row.url ?? '').includes('/v1/messages') && !String(row.url).includes('count_tokens')
  );

const gapsMs = (rows) => {
  const times = rows.map((row) => Date.parse(row.time)).filter((time) => Number.isFinite(time));
  return times.slice(1).map((time, index) => time - times[index]);
};

// The engine wait before retry `attempt` (1-based), without its jitter.
const backoffMs = (attempt) => Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));

const isOpus = (model) => /opus/iu.test(String(model ?? ''));

// What the first watchdog review showed: its spawn model, its end, its error text, its last step (§12.1, §12.2).
const reviewFact = (events) => {
  const spawn = watchdogSpawns(events)[0] ?? null;
  const agentId = spawn?.agentId ?? null;
  const end = agentId ? (agentTurnCompletes(events).find((event) => event.agentId === agentId) ?? null) : null;
  const steps = agentId ? ofEvent(events, 'turn.step', (event) => event.agentId === agentId) : [];
  return {
    spawned: spawn !== null,
    agentId,
    spawnModel: spawn?.model ?? null,
    usage: end?.usage?.model ?? null,
    ran: end?.usage?.model ?? spawn?.model ?? null,
    end,
    error: agentId ? (syntheticTexts(events, agentId).at(-1) ?? null) : null,
    lastIndex: Math.max(-1, ...steps.map((step) => step.index ?? -1)),
  };
};

// What the `rf-model` probe agent ran on (§12.2). `resolved` is the engine's pick at the spawn (the spawn result,
// else the first step): the alias resolution and any allowlist step-down. `ran` is the last model named; on 2.1.290
// a first-party model_not_found or access refusal can switch a running agent to a fallback model.
const modelAgent = (events) => {
  const spawn = ofEvent(events, 'agent.spawn.out', (event) => event.subagentType === MODEL_TYPE)[0] ?? null;
  const agentId = spawn?.result?.agentId ?? null;
  const end = agentId ? (ofEvent(events, 'turn.complete', (event) => event.agentId === agentId)[0] ?? null) : null;
  const steps = agentId
    ? ofEvent(events, 'turn.step', (event) => event.agentId === agentId).map((event) => event.model)
    : [];
  const named = (id) => (id && id !== 'inherit' ? id : null);
  const ids = [spawn?.result?.model, ...steps, end?.usage?.model].map(named).filter(Boolean);
  return {
    agentId,
    ids: [...new Set(ids)],
    resolved: named(spawn?.result?.model) ?? named(steps[0]),
    ran: named(end?.usage?.model) ?? named(steps.at(-1)) ?? named(spawn?.result?.model),
    reason: end?.reason ?? null,
    error: agentId ? (syntheticTexts(events, agentId).at(-1) ?? null) : null,
  };
};

const modelLine = (label, fact) =>
  clip(
    `${label}: agent ${fact.agentId ?? 'none'}, resolved ${fact.resolved ?? 'none'}, ` +
      `ids ${fact.ids.join(',') || 'none'}, end ${fact.reason ?? 'none'}${fact.error ? `, error ${fact.error}` : ''}`,
    280
  );

const reviewLine = (label, fact) =>
  clip(
    `${label}: spawn ${fact.spawnModel ?? 'none'}, usage ${fact.usage ?? 'none'}, end ${fact.end?.reason ?? 'none'}` +
      (fact.error ? `, error ${fact.error}` : ''),
    280
  );

const readModState = (run) => {
  try {
    return JSON.parse(readText(path.join(run.logs, 'rf-model.json')));
  } catch {
    return null;
  }
};

// The reply of a `/watchdog` command as the observer saw it (`command.run.out`), after time `after`.
const commandOut = (events, args, after = 0) =>
  ofEvent(
    events,
    'command.run.out',
    (event) => event.command === 'watchdog' && event.args === args && event.t > after
  )[0];

const commandReply = (run, args, after, timeoutMs = 30_000) =>
  waitObs(run, (events) => commandOut(events, args, after), { timeoutMs });

// One `-p` session with stream-json input on a run (§16.3): CLAUDE_WATCHDOG=on, the prompt SHORT, then stdin stays
// open until `until(events)` holds or `waitMs` passed; `after(send, run)` may send more. `timeoutMs` kills it.
const session = async (run, options) => {
  const { env = {}, args = [], mods = [], fill = {}, until, waitMs = 100_000, intervalMs = 1000, after } = options;
  const { timeoutMs = waitMs + 60_000 } = options;
  const p = await runHeadless(run, {
    label: 'p',
    env: { CLAUDE_WATCHDOG: 'on', ...env },
    args,
    plugins: pluginDirs(run, { mods, fill }),
    input: async (send) => {
      send(SHORT);
      await waitObs(run, until, { timeoutMs: waitMs, intervalMs });
      if (after) {
        await after(send, run);
      }
    },
    closeAfterMs: 8_000,
    timeoutMs,
  });
  await sleep(1500);
  return { run, session: p, events: readObs(run) };
};

// The first review ended, or the plugin gave its watchdog a problem state before any spawn (§12.5 row).
const reviewSettled = (events) => {
  const review = reviewFact(events);
  return review.end !== null || (!review.spawned && problemRows(events).length > 0);
};

// --- model compare (§12.2): fable, availableModels step-down, managed availableModels ------------------------------

// The `rf-model` agent ended or its register or spawn failed, and the watchdog review settled.
const modelsSettled = (run) => (events) => {
  const mod = readModState(run);
  const isModDone = modelAgent(events).reason !== null || Boolean(mod?.register?.error || mod?.spawn?.error);
  return isModDone && reviewSettled(events);
};

// One session with a watchdog of `model` and the `rf-model` agent of the same model; `args` adds settings flags.
const modelSession = async (ctx, name, model, args = []) => {
  const run = createRun(ctx, name, { files: { 'WATCHDOG.json': roster(model) } });
  const obs = await session(run, {
    args,
    mods: ['rf-model'],
    fill: { __MODEL__: model },
    until: modelsSettled(run),
    waitMs: 120_000,
  });
  return { ...obs, mod: readModState(run), engine: debugLines(obs.session.debugFile, ALLOWLIST_LINE) };
};

// §16.5: the alias `fable` names one family, and a fable id contains `fable`.
const fable = {
  id: 'rf-fable',
  title: 'A fable watchdog and a fable probe agent in one -p session',
  needs: [],
  run: (ctx) => modelSession(ctx, 'rf-fable', 'fable'),
};

// §16.5: `availableModels` steps a blocked model down, from `--settings` and from the managed (policy) tier. The
// managed run uses `--managed-settings <json>`, the policy tier a parent process hands over (2.1.290 hidden flag:
// "Policy-tier settings JSON from a spawning parent process"); with no admin tier it is the only policy source, so
// it needs no installed managed-settings.json (CLAUDE_CODE_MANAGED_SETTINGS_PATH is a stub on 2.1.290).
const allow = {
  id: 'rf-allow',
  title: 'Sonnet watchdog and sonnet probe agent, allowlist without the newest sonnet: --settings, then managed',
  needs: [],
  run: async (ctx) => {
    const flag = JSON.stringify(STEP_DOWN_ALLOW);
    return {
      settings: await modelSession(ctx, 'rf-allow-settings', 'sonnet', ['--settings', flag]),
      managed: await modelSession(ctx, 'rf-allow-managed', 'sonnet', ['--managed-settings', flag]),
    };
  },
};

// --- engine retries: one proxy, two short -p runs ---------------------------------------------------------------

// The count run: 8 retries of a 529 on the watchdog agent (9 requests, about 100 s of waits). The cutoff run:
// CLAUDE_CODE_MAX_RETRIES=20 (the clamp warn) and a retry-after of 61 s on the 529.
const retry = {
  id: 'rf-retry',
  title: 'Proxy 529s on the watchdog agent: retry count and waits, the clamp at 15, the retry-after cutoff',
  needs: ['proxy'],
  run: async (ctx) => {
    const countRun = createRun(ctx, 'rf-retry-count', { files: { 'WATCHDOG.json': roster('haiku') } });
    const proxy = await startProxy(countRun, { agent: 529 });
    const part = async (run, maxRetries, mode, waitMs) => {
      proxy.setMode(mode);
      const from = proxy.log().length;
      const obs = await session(run, {
        env: { ...proxy.env, CLAUDE_CODE_MAX_RETRIES: String(maxRetries) },
        until: reviewsDone(1),
        waitMs,
      });
      return { ...obs, maxRetries, mode, log: proxy.log().slice(from) };
    };
    try {
      const count = await part(countRun, COUNT_RETRIES, { agent: 529 }, 170_000);
      const cutoffRun = createRun(ctx, 'rf-retry-cutoff', { files: { 'WATCHDOG.json': roster('haiku') } });
      const cutoff = await part(cutoffRun, 20, { agent: 529, retryAfter: 61 }, 45_000);
      return { count, cutoff, proxyDir: proxy.dir };
    } finally {
      proxy.stop();
    }
  },
};

// --- Opus fallback: any account, with --fallback-model ----------------------------------------------------------

// §16.5: an Opus agent falls back after 3 529s. 2.1.290 counts the 529s of any model once `fallbackModel` is set,
// so `--fallback-model sonnet` shows whether a watchdog agent gets the session's fallback, on any account. When a
// non-Opus agent request shows, the proxy forwards again so the fallback review ends; MAX_RETRIES=4 bounds a run
// with no fallback (5 Opus requests).
const fallback = {
  id: 'rf-fallback',
  title: 'Proxy 529s on an Opus watchdog with --fallback-model sonnet',
  needs: ['proxy'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rf-fallback', { files: { 'WATCHDOG.json': roster('opus') } });
    const proxy = await startProxy(run, { agent: 529 });
    let forwardedAt = null;
    try {
      const obs = await session(run, {
        env: { ...proxy.env, CLAUDE_CODE_MAX_RETRIES: '4' },
        args: ['--fallback-model', 'sonnet'],
        until: (events) => {
          if (forwardedAt === null && agentRequests(proxy.log()).some((row) => !isOpus(row.model))) {
            forwardedAt = Date.now();
            proxy.setMode({});
          }
          return reviewSettled(events);
        },
        waitMs: 90_000,
        intervalMs: 250,
      });
      return { ...obs, log: proxy.log(), forwardedAt };
    } finally {
      proxy.stop();
    }
  },
};

// --- TUI: /tasks stop -------------------------------------------------------------------------------------------

// The stop facts of research/smoke-review-failures.md case 5 (`ctrl+x ctrl+k` twice): the agent's `aborted` end,
// the main prompt `Background agent "…" was stopped by the user.` and a main turn after it.
const stopFacts = (events, agentId, after) => {
  const end = agentTurnCompletes(events).find((event) => event.agentId === agentId) ?? null;
  const prompt =
    ofEvent(events, 'prompt.submit', (event) => !event.agentId && STOPPED_PROMPT.test(String(event.text)))[0] ?? null;
  const turn = prompt ? (mainTurnCompletes(events).find((event) => event.t > prompt.t) ?? null) : null;
  return { end, isLate: end !== null && end.t > after, prompt, turn };
};

// The /tasks dialog's key hints (2.1.290 renders `<chord> to <action>`): a running row shows `x to stop`. The
// prompt footer's `ctrl+x to stop` (a selected agents-panel row) is not one. The agents panel below the prompt always
// shows the row `watchdog probe review`, so the row text alone does not tell the dialog is open.
const STOP_HINT = /(?<![+\w])x to stop\b/u;
const DIALOG_HINT = /(?<![+\w])x to stop\b|\besc to close\b|\benter to view\b/iu;

const tasks = {
  id: 'rf-tasks',
  title: 'TUI: /tasks stops a watchdog review that retries proxy 529s',
  needs: ['tui', 'proxy'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rf-tasks', { files: { 'WATCHDOG.json': roster('haiku') } });
    const proxy = await startProxy(run, { agent: 529 });
    let tui = null;
    const screens = {};
    try {
      // The default 10 retries keep the review alive for about 180 s.
      tui = await startTui(run, { label: 'tui', env: proxy.env });
      const tOn = Date.now();
      await tui.type('/watchdog on');
      const on = await commandReply(run, 'on', tOn);
      await tui.type(SHORT);
      const spawned = await waitObs(run, (events) => watchdogSpawns(events)[0]?.agentId, { timeoutMs: 90_000 });
      // The main turn ended (the TUI footer shows no `? for shortcuts` while an agent runs, so no waitIdle) and the
      // review waits between 529 retries.
      await waitObs(run, (events) => mainTurnCompletes(events).length >= 1, { timeoutMs: 60_000 });
      await waitObs(run, () => agentRequests(proxy.log()).length >= 2, { timeoutMs: 20_000 });
      await sleep(1000);
      screens.before = tui.capture('before-tasks');
      await tui.type('/tasks');
      const opened = await tui.waitFor((text) => DIALOG_HINT.test(text) && text.includes('watchdog probe review'), {
        timeoutMs: 15_000,
      });
      screens.tasks = tui.capture('tasks');
      if (opened.ok && !STOP_HINT.test(opened.text)) {
        await tui.keys('Enter');
        await sleep(1000);
        screens.detail = tui.capture('tasks-detail');
      }
      const stoppedAt = Date.now();
      await tui.keys('x');
      await sleep(1500);
      screens.stop = tui.capture('tasks-x');
      const agentId = spawned.value ?? null;
      // The stop's end, its main prompt and that prompt's turn (or another end), at most 45 s.
      await waitObs(
        run,
        (events) => {
          const facts = stopFacts(events, agentId, stoppedAt);
          return facts.end && (facts.turn || facts.end.reason !== 'aborted') ? facts : null;
        },
        { timeoutMs: 45_000 }
      );
      await tui.keys('Escape');
      await sleep(1000);
      screens.after = tui.capture('after-stop');
      return {
        run,
        screens,
        on: on.value ?? null,
        agentId,
        opened: opened.ok,
        stoppedAt,
        events: readObs(run),
        proxyLog: proxy.log(),
      };
    } finally {
      if (tui) {
        await tui.stop();
      }
      proxy.stop();
    }
  },
};

// --- gated: failure rows of a real account (§12.2, §12.3) ---------------------------------------------------------

// A second person prompt and its main turn, then the review it tried (§12.3 items 2, 3), if any. Bounded waits.
const secondPrompt = async (send, run) => {
  send('Reply with the single word OK again.');
  await waitObs(run, (events) => mainTurnCompletes(events).length >= 2, { timeoutMs: 50_000 });
  await waitObs(run, (events) => watchdogSpawns(events).length < 2 || reviewsDone(2)(events), { timeoutMs: 40_000 });
};

// One `-p` session of an account in a given state: SHORT, then `after` once the first review settled. The dump is
// moved into the run.
const accountSession = async (ctx, name, { files = {}, mods = [], waitMs = 100_000, after = secondPrompt } = {}) => {
  const run = createRun(ctx, name, { files: { 'WATCHDOG.json': roster('haiku'), ...files } });
  const obs = await session(run, { mods, until: reviewSettled, waitMs, after });
  return { ...obs, dumps: collectDumps(run, [obs.session.sessionId]) };
};

// §16.5: a real subscription limit (research/smoke-review-failures.md:253; the proxy made case 4d).
const limit = {
  id: 'rf-limit',
  title: 'A real subscription limit on a haiku watchdog, then a second person prompt',
  needs: ['account:limit'],
  run: (ctx) => accountSession(ctx, 'rf-limit'),
};

// §16.4 #9, §16.5: a real `billing_error` row (first check 9 saw it only from the proxy).
const billing = {
  id: 'rf-billing',
  title: 'A real billing_error row on an API-key account with no credit',
  needs: ['account:billing'],
  run: (ctx) => accountSession(ctx, 'rf-billing'),
};

// §12.3 item 4: the watchdog sends its note, then reads overflow.txt, which the `rf-overflow` mod inflates past
// the context, so a later request of the same review is too long.
const OVERFLOW_INSTRUCTIONS =
  'This is a live probe. Do these steps in order. 1. Call note once with severity nit and the text "WDPROBE ' +
  'overflow probe: math.js add returns a - b". 2. Call Read on overflow.txt with no offset and no limit. 3. End the ' +
  'review with done.';

// §12.4: the failure count shows only in `/watchdog status` (`fail N/3`); -p runs a slash command from stdin.
const statusPrompt = async (send, run) => {
  await sleep(3000);
  const after = Date.now();
  send('/watchdog status');
  await commandReply(run, 'status', after);
};

const tooLong = {
  id: 'rf-too-long',
  title: 'Prompt is too long at a later step of a watchdog review, then /watchdog status',
  needs: ['account:api-key'],
  run: async (ctx) => {
    const obs = await accountSession(ctx, 'rf-too-long', {
      files: {
        'WATCHDOG.json': roster('haiku', { tools: ['Read'], instructions: OVERFLOW_INSTRUCTIONS }),
        'overflow.txt': 'overflow probe file\n',
      },
      mods: ['rf-overflow'],
      waitMs: 120_000,
      after: statusPrompt,
    });
    return { ...obs, hook: readText(path.join(obs.run.logs, 'rf-overflow.json')) };
  },
};

// §12.1: an Opus watchdog of an API-key account, every agent request a 529, no fallback model.
const opus = {
  id: 'rf-opus',
  title: 'Proxy 529s on an Opus watchdog of an API-key account, no fallback model',
  needs: ['account:api-key', 'proxy'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rf-opus', { files: { 'WATCHDOG.json': roster('opus') } });
    const proxy = await startProxy(run, { agent: 529 });
    try {
      const obs = await session(run, { env: proxy.env, until: reviewSettled, waitMs: 60_000 });
      return { ...obs, log: proxy.log() };
    } finally {
      proxy.stop();
    }
  },
};

// --- verify: model compare ----------------------------------------------------------------------------------------

// The debug-file `[WARN]` lines of a subagent model that the allowlist (or an entitlement) blocked.
const engineLines = (obs) => obs.engine ?? [];

const engineEvidence = (obs, label = 'engine') => engineLines(obs).map((line) => `${label}: ${clip(line, 220)}`);

// The engine could not run the alias for this account: it inherited the parent model (the allowlist or an
// entitlement), or the API said model_not_found.
const accountCannotRun = (fact, lines) =>
  lines.some((line) => line.includes('inheriting the parent model')) ||
  /There's an issue with the selected model/u.test(fact.error ?? '');

// rf-fable-id: the id the engine resolves the alias `fable` to (at the spawn) contains `fable`, so the alias names
// the fable family. A model_not_found still names that id; a later switch to a fallback model is evidence only.
const fableIds = (obs) => {
  const fact = modelAgent(obs.events);
  const switched = fact.ran && fact.ran !== fact.resolved ? [`the run then switched to ${fact.ran}`] : [];
  const evidence = [modelLine('probe agent', fact), ...switched, ...engineEvidence(obs)];
  if (!fact.agentId || !fact.resolved) {
    return inconclusive(['the fable probe agent did not spawn or named no model', clip(obs.mod), ...evidence]);
  }
  if (fact.resolved.includes('fable')) {
    return pass([`the alias fable resolved to ${fact.resolved}`, ...evidence]);
  }
  return engineLines(obs).some((line) => line.includes('inheriting the parent model'))
    ? inconclusive(['the account cannot use fable: the engine inherited the parent model', ...evidence])
    : fail([`the alias fable resolved to ${fact.resolved}, an id without fable`, ...evidence]);
};

// rf-fable-compare: the plugin's §12.2 compare accepts a fable id (no `availableModels gave` row) and reports
// another id as no_model.
const fableCompare = (obs) => {
  const review = reviewFact(obs.events);
  const noModel = stateRow(obs.events, 'no_model');
  const evidence = [reviewLine('watchdog review', review), noModel ? clip(noModel) : 'no no_model row'];
  if (!review.spawned) {
    return noModel
      ? inconclusive(['the account cannot run fable: the plugin set no_model before any review', ...evidence])
      : inconclusive(['no fable review spawned and no problem row', ...evidence]);
  }
  if (!review.ran) {
    return inconclusive(['the review named no model', ...evidence]);
  }
  const gave = noModel?.includes('availableModels gave') ?? false;
  if (review.ran.includes('fable')) {
    if (gave) {
      return fail(['§12.2: a fable id must match the alias fable, but the plugin set no_model', ...evidence]);
    }
    if (review.end?.reason === 'error' && accountCannotRun(review, engineLines(obs))) {
      return inconclusive(['the compare passed, but the account cannot run fable (model_not_found)', ...evidence]);
    }
    return review.end?.reason === 'answer' && !noModel
      ? pass(evidence)
      : inconclusive(['the fable review did not end with an answer', ...evidence]);
  }
  return gave
    ? pass([`§12.2: ${review.ran} is no fable id, and the plugin said so`, ...evidence])
    : fail([`§12.2: the review ran on ${review.ran}, and the plugin wrote no availableModels gave row`, ...evidence]);
};

// rf-stepdown: the sonnet probe agent under `--settings` is blocked (its alias names claude-sonnet-5-5) and runs on
// the newest allowed sonnet, claude-sonnet-4-6, with the engine warn `… using the newest allowed model in its
// family`.
const stepDown = (obs) => {
  const fact = modelAgent(obs.settings.events);
  const lines = engineLines(obs.settings);
  const evidence = [modelLine('probe agent', fact), ...engineEvidence(obs.settings), clip(obs.settings.mod)];
  if (!fact.agentId || !fact.resolved) {
    return inconclusive(['the sonnet probe agent did not spawn or named no model', ...evidence]);
  }
  if (lines.length === 0 && fact.resolved.includes(STEP_DOWN_TARGET)) {
    return inconclusive(['no allowlist warn: the sonnet alias named an allowed model, nothing to step', ...evidence]);
  }
  return expectAll(
    {
      [`spawned on the newest allowed sonnet ${STEP_DOWN_TARGET}`]: fact.resolved.includes(STEP_DOWN_TARGET),
      'the engine warned: using the newest allowed model in its family': lines.some((line) =>
        line.includes('using the newest allowed model in its family')
      ),
    },
    evidence
  );
};

// rf-stepdown-review: the plugin's state follows the engine (§5.2 preflight, §12.2 compare): when the engine runs
// the sonnet alias on a sonnet id, the watchdog reviews with no no_model; when it inherits the parent, no_model.
const stepDownReview = (obs) => {
  const fact = modelAgent(obs.settings.events);
  const review = reviewFact(obs.settings.events);
  const noModel = stateRow(obs.settings.events, 'no_model');
  const evidence = [
    modelLine('probe agent', fact),
    reviewLine('watchdog review', review),
    noModel ? clip(noModel) : 'no no_model row',
  ];
  if (!fact.resolved) {
    return inconclusive(['the probe agent named no model, so what the engine runs is unknown', ...evidence]);
  }
  if (/sonnet/u.test(fact.resolved)) {
    if (!review.spawned && noModel) {
      return fail([
        `§12.2: the engine runs the sonnet alias on ${fact.resolved}, but the plugin set no_model before any review`,
        ...evidence,
      ]);
    }
    return expectAll(
      { 'the review ran on a sonnet id': /sonnet/u.test(review.ran ?? ''), 'no no_model row': !noModel },
      evidence
    );
  }
  return expectAll({ [`the engine gave ${fact.resolved}, and the plugin set no_model`]: Boolean(noModel) }, evidence);
};

// The plugin's state for its watchdog: its problem row, else the model its review ran on.
const pluginState = (events) => problemRows(events)[0] ?? `review on ${reviewFact(events).ran ?? 'none'}`;

// rf-managed: the managed (policy-tier) allowlist gives the same agent model and the same plugin state as the flag.
const managedLikeFlag = (obs) => {
  const left = modelAgent(obs.settings.events);
  const right = modelAgent(obs.managed.events);
  const leftState = pluginState(obs.settings.events);
  const rightState = pluginState(obs.managed.events);
  const evidence = [
    modelLine('--settings probe agent', left),
    modelLine('managed probe agent', right),
    `--settings plugin: ${clip(leftState, 200)}`,
    `managed plugin: ${clip(rightState, 200)}`,
    ...engineEvidence(obs.managed, 'managed engine'),
  ];
  if (!left.resolved || !right.resolved) {
    return inconclusive(['a probe agent named no model', ...evidence]);
  }
  const isSame = left.resolved === right.resolved && leftState === rightState;
  // A server-managed or admin tier on this machine takes the policy tier (lib/env.mjs): the parent tier that
  // `--managed-settings` sets then applies nothing, so a difference says nothing about managed settings.
  const tier = managedTier();
  if (!isSame && tier) {
    return inconclusive([`${tier} takes the policy tier, so --managed-settings applied nothing`, ...evidence]);
  }
  return expectAll(
    { 'the same agent model': left.resolved === right.resolved, 'the same plugin state': leftState === rightState },
    evidence
  );
};

// --- verify: engine retries -----------------------------------------------------------------------------------------

const retryEvidence = (part) => {
  const rows = agentRequests(part.log);
  const review = reviewFact(part.events);
  return [
    `MAX_RETRIES=${part.maxRetries}, mode ${clip(part.mode, 80)}`,
    `agent requests ${rows.length}, gaps ms ${gapsMs(rows).join(',') || 'none'}`,
    reviewLine('review', review),
    `exit ${part.session.exitCode}, timedOut ${part.session.isTimedOut}, wall ${part.session.wallMs} ms`,
  ];
};

// rf-retry-count: CLAUDE_CODE_MAX_RETRIES=8 gives 1 + 8 agent requests.
const retryCount = (obs) => {
  const rows = agentRequests(obs.count.log);
  const evidence = retryEvidence(obs.count);
  if (rows.length === 0) {
    return inconclusive(['no watchdog agent request reached the proxy', ...evidence]);
  }
  return rows.length === obs.count.maxRetries + 1
    ? pass(evidence)
    : fail([`expected ${obs.count.maxRetries + 1} agent requests`, ...evidence]);
};

// rf-retry-agent: a 529 on the watchdog agent (query source `agent:…`) is retried in full, not dropped after one
// request as a background query's 529 is; the review then ends `error` with the 529 row.
const retryAgent = (obs) => {
  const rows = agentRequests(obs.count.log);
  const review = reviewFact(obs.count.events);
  const evidence = retryEvidence(obs.count);
  if (!review.spawned) {
    return inconclusive(['no watchdog review spawned', ...evidence]);
  }
  return expectAll(
    {
      [`${obs.count.maxRetries + 1} agent requests`]: rows.length === obs.count.maxRetries + 1,
      'the review ended reason error': review.end?.reason === 'error',
      [`its row has ${OVERLOAD_PHRASE}`]: (review.error ?? '').includes(OVERLOAD_PHRASE),
    },
    evidence
  );
};

// rf-retry-max: CLAUDE_CODE_MAX_RETRIES=20 is clamped to 15, with the 2.1.290 warn line.
const retryMax = (obs) => {
  const debug = readText(obs.cutoff.session.debugFile);
  if (debug === '') {
    return inconclusive(['the cutoff session wrote no debug file']);
  }
  const line = `${obs.cutoff.session.stderr}\n${debug}`.split('\n').find((row) => CLAMP_LINE.test(row)) ?? null;
  return line
    ? pass([clip(line, 240)])
    : fail(['MAX_RETRIES=20 gave no "clamped to 15" warn in stderr or the debug file']);
};

// rf-retry-cutoff: a 529 with retry-after 61 s gets no retry.
const retryCutoff = (obs) => {
  const rows = agentRequests(obs.cutoff.log);
  const review = reviewFact(obs.cutoff.events);
  const evidence = retryEvidence(obs.cutoff);
  if (rows.length === 0) {
    return inconclusive(['no watchdog agent request reached the proxy', ...evidence]);
  }
  return expectAll(
    { 'one agent request': rows.length === 1, 'the review ended reason error': review.end?.reason === 'error' },
    evidence
  );
};

// rf-retry-timing: wait n is 500 ms × 2^(n-1), capped at 32 s, plus up to 25 % jitter (plus the request overhead).
// The jitter shows in the waits of 8 s and more: their excess over the base spans seconds (0 to 2-8 s), while the
// overhead of each request stays a few hundred ms.
const retryTiming = (obs) => {
  const gaps = gapsMs(agentRequests(obs.count.log));
  const bases = gaps.map((_, index) => backoffMs(index + 1));
  const isInBand = gaps.every((gap, index) => gap >= bases[index] - 100 && gap <= bases[index] * (1 + JITTER) + 1500);
  const excess = gaps.map((gap, index) => gap - bases[index]).filter((_, index) => bases[index] >= 8000);
  const spread = excess.length > 1 ? Math.max(...excess) - Math.min(...excess) : 0;
  const evidence = [
    `gaps ms ${gaps.join(',')}`,
    `bases ms ${bases.join(',')}`,
    `excess ms (base >= 8 s) ${excess.join(',')}`,
  ];
  if (gaps.length < COUNT_RETRIES) {
    return inconclusive([`only ${gaps.length} waits were recorded, ${COUNT_RETRIES} needed for the cap`, ...evidence]);
  }
  return expectAll(
    {
      'each wait is 500 ms × 2^(n-1) plus 0 to 25 %': isInBand,
      'wait 8 is capped at 32 s (64 s uncapped)': gaps[COUNT_RETRIES - 1] <= CAP_MS * (1 + JITTER) + 1500,
      'the waits jitter (excess spread > 1 s)': spread > 1000,
    },
    evidence
  );
};

// rf-opus-fallback: after 3 Opus 529s, the next agent request uses another model (the session's fallback).
const opusFallback = (obs) => {
  const rows = agentRequests(obs.log);
  const models = rows.map((row) => row.model ?? '?');
  const firstOther = rows.findIndex((row) => !isOpus(row.model));
  const review = reviewFact(obs.events);
  const evidence = [
    `agent request models ${models.join(',') || 'none'}`,
    reviewLine('review', review),
    problemRows(obs.events)[0] ? clip(problemRows(obs.events)[0]) : 'no problem row',
  ];
  if (!review.spawned) {
    return inconclusive(['no Opus review spawned', ...evidence]);
  }
  if (rows.length < 3) {
    return inconclusive(['fewer than 3 agent requests reached the proxy', ...evidence]);
  }
  if (firstOther === 3) {
    return pass([`fell back to ${rows[3].model} after 3 Opus 529s`, ...evidence]);
  }
  const other = firstOther === -1 ? 'every agent request stayed on Opus' : `another model came at ${firstOther + 1}`;
  return fail([`no fallback after 3 Opus 529s: ${other}`, ...evidence]);
};

// --- verify: /tasks stop -------------------------------------------------------------------------------------------

const screenExcerpt = (text) =>
  clip(
    String(text ?? '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .slice(-10)
      .join(' | '),
    280
  );

// rf-tasks-stop: as `ctrl+x ctrl+k` twice: `reason: "aborted"`, `isAborted: true`, the main prompt and its turn;
// §12.3 item 7: no problem row for the stopped review.
const tasksStop = (obs) => {
  const facts = stopFacts(obs.events, obs.agentId, obs.stoppedAt);
  const end = facts.end ? `reason ${facts.end.reason}, isAborted ${facts.end.isAborted}` : 'no end';
  const evidence = [
    `agent ${obs.agentId ?? 'none'}: ${end}`,
    facts.prompt ? clip(facts.prompt.text, 160) : 'no stopped-by-the-user prompt',
    facts.turn ? `main turn after it: ${facts.turn.reason}` : 'no main turn after it',
    `agent requests ${agentRequests(obs.proxyLog ?? []).length}`,
    `tasks: ${screenExcerpt(obs.screens?.tasks)}`,
    `after x: ${screenExcerpt(obs.screens?.stop)}`,
  ];
  if (!obs.agentId) {
    return inconclusive(['no review ran to stop', ...evidence]);
  }
  if (!obs.opened) {
    return inconclusive(['/tasks did not list the review', ...evidence]);
  }
  if (facts.end && !facts.isLate) {
    return inconclusive(['the review ended before the stop', ...evidence]);
  }
  return expectAll(
    {
      'the agent ended reason aborted, isAborted true': facts.end?.reason === 'aborted' && facts.end.isAborted === true,
      'a main prompt said the agent was stopped by the user': Boolean(facts.prompt),
      'a main turn ran on it': Boolean(facts.turn),
      '§12.3 item 7: no problem row': problemRows(obs.events).length === 0,
    },
    evidence
  );
};

// --- verify: gated rows of a real account -------------------------------------------------------------------------

// rf-limit: §12.2 the exact phrase gives `limited` with a row; §12.3 item 3 keeps the backlog and tries one review
// at the next person prompt, and a limit counts nothing toward the halt.
const limitKept = (obs) => {
  const review = reviewFact(obs.events);
  const row = review.error?.includes(LIMIT_PHRASE) ? review.error : null;
  const limited = stateRow(obs.events, 'limited');
  const spawns = watchdogSpawns(obs.events);
  const unreviewed = /unreviewed: [1-9]\d* updates/u.test(dumpText(obs.dumps));
  const evidence = [
    reviewLine('first review', review),
    limited ? clip(limited) : 'no limited row',
    `spawns ${spawns.length}, main turns ${mainTurnCompletes(obs.events).length}`,
    unreviewed ? 'dump: unreviewed updates' : 'dump: no unreviewed record',
  ];
  if (!row) {
    return inconclusive(['the first review did not end on the subscription limit', ...evidence]);
  }
  return expectAll(
    {
      [`the row has the exact phrase ${LIMIT_PHRASE}`]: true,
      'row watchdog: probe limited: <the text>': Boolean(limited?.includes(LIMIT_PHRASE)),
      'backlog kept: the next person prompt tried one review, or the dump kept the updates':
        spawns.length >= 2 || unreviewed,
      'no halted row': stateRow(obs.events, 'halted') === null,
    },
    evidence
  );
};

// rf-billing: §16.4 #9 the real row has `Credit balance is too low`; §12.3 item 2 billing halts at the first failure.
const billingHalt = (obs) => {
  const review = reviewFact(obs.events);
  const halted = stateRow(obs.events, 'halted');
  const evidence = [
    reviewLine('first review', review),
    halted ? clip(halted) : 'no halted row',
    `main result: ${clip(obs.session.result?.result ?? obs.session.stderr ?? '', 200)}`,
  ];
  if (!review.end || review.end.reason !== 'error') {
    return inconclusive(['the first review did not fail, so the account gave no billing row', ...evidence]);
  }
  return expectAll(
    {
      [`the row has ${BILLING_PHRASE}`]: (review.error ?? '').includes(BILLING_PHRASE),
      'halted at the first failure, with the text': Boolean(halted?.includes(BILLING_PHRASE)),
    },
    evidence
  );
};

// rf-too-long: §12.3 item 4 at a later step: keep the notes, move the cursor, count no failure, no step-0 retry.
const tooLongKept = (obs) => {
  const review = reviewFact(obs.events);
  const row = review.error?.includes(TOO_LONG_PHRASE) ? review.error : null;
  const notes = noteCalls(obs.events).filter((event) => event.agentId === review.agentId);
  const record = dumpReviews(dumpText(obs.dumps)).find((item) => item.agentId === review.agentId) ?? null;
  const status = commandOut(obs.events, 'status');
  const evidence = [
    `hook ${clip(obs.hook || 'no rf-overflow.json', 160)}`,
    reviewLine('review', review),
    `last step index ${review.lastIndex}, note calls ${notes.length}, spawns ${watchdogSpawns(obs.events).length}`,
    record ? clip(`dump: ${record.end}; notes ${record.notes}`, 200) : 'no dump record',
    status ? `status: ${clip(status.text, 220)}` : 'no /watchdog status reply',
  ];
  if (!row) {
    return inconclusive(['the review did not end on Prompt is too long', ...evidence]);
  }
  if (review.lastIndex < 1) {
    return inconclusive(['Prompt is too long came at step 0, not at a later step', ...evidence]);
  }
  if (notes.length === 0) {
    return inconclusive(['the watchdog sent no note before the overflow, so kept notes cannot show', ...evidence]);
  }
  if (!status) {
    return inconclusive(['/watchdog status gave no reply, so the failure count cannot show', ...evidence]);
  }
  return expectAll(
    {
      'no step-0 retry: one review spawned': watchdogSpawns(obs.events).length === 1,
      'the note is kept (dump notes >= 1, none dropped)':
        Boolean(record) && /^[1-9]/u.test(record.notes ?? '') && !/\(dropped/u.test(record.text),
      'no failure counted (no fail N/3 in /watchdog status)': !/\bfail \d+\/\d+/u.test(String(status.text ?? '')),
      'no problem row': problemRows(obs.events).length === 0,
    },
    evidence
  );
};

// rf-opus-529: §12.1 3 Opus 529s in a row end the request with `Repeated 529 Overloaded errors`; §12.2 classes it
// overload, one plain failure, which writes no row (§12.5).
const opusEarlyEnd = (obs) => {
  const rows = agentRequests(obs.log);
  const review = reviewFact(obs.events);
  const evidence = [
    `agent request models ${rows.map((row) => row.model ?? '?').join(',') || 'none'}`,
    reviewLine('review', review),
    problemRows(obs.events)[0] ? clip(problemRows(obs.events)[0]) : 'no problem row',
  ];
  if (!review.spawned) {
    return inconclusive(['no Opus review spawned', ...evidence]);
  }
  return expectAll(
    {
      '3 agent requests, all Opus': rows.length === 3 && rows.every((row) => isOpus(row.model)),
      [`the row has ${OPUS_PHRASE}`]: (review.error ?? '').includes(OPUS_PHRASE),
      'the review ended reason error': review.end?.reason === 'error',
      '§12.5: one failed review writes no row': problemRows(obs.events).length === 0,
    },
    evidence
  );
};

export const scenarios = [fable, allow, retry, fallback, tasks, limit, billing, tooLong, opus];

export const checks = [
  {
    id: 'rf-fable-id',
    title: 'The alias fable names one family: every model id the engine runs for it contains fable',
    source: '§16.5: model compare, fable',
    kind: 'deterministic',
    scenario: 'rf-fable',
    verify: fableIds,
  },
  {
    id: 'rf-fable-compare',
    title: 'The §12.2 compare accepts a fable id for the roster alias fable',
    source: '§16.5: model compare, fable',
    kind: 'deterministic',
    scenario: 'rf-fable',
    verify: fableCompare,
  },
  {
    id: 'rf-stepdown',
    title: 'availableModels steps a blocked sonnet down to the newest allowed sonnet',
    source: '§16.5: model compare, availableModels steps a blocked model down',
    kind: 'advisory',
    scenario: 'rf-allow',
    verify: stepDown,
  },
  {
    id: 'rf-stepdown-review',
    title: 'A sonnet watchdog follows the engine: it reviews on the stepped-down sonnet, no no_model',
    source: '§16.5: model compare, availableModels steps a blocked model down',
    kind: 'deterministic',
    scenario: 'rf-allow',
    verify: stepDownReview,
  },
  {
    id: 'rf-managed',
    title: 'A managed availableModels acts like the --settings flag',
    source: '§16.5: engine retry behavior, a managed availableModels acts like --settings',
    kind: 'advisory',
    scenario: 'rf-allow',
    verify: managedLikeFlag,
  },
  {
    id: 'rf-retry-count',
    title: 'CLAUDE_CODE_MAX_RETRIES sets the retry count',
    source: '§16.5: engine retry behavior, CLAUDE_CODE_MAX_RETRIES sets the retry count, max 15',
    kind: 'advisory',
    scenario: 'rf-retry',
    verify: retryCount,
  },
  {
    id: 'rf-retry-max',
    title: 'CLAUDE_CODE_MAX_RETRIES above 15 is clamped to 15',
    source: '§16.5: engine retry behavior, CLAUDE_CODE_MAX_RETRIES sets the retry count, max 15',
    kind: 'advisory',
    scenario: 'rf-retry',
    verify: retryMax,
  },
  {
    id: 'rf-retry-timing',
    title: 'The retry wait is exponential from 500 ms, with a cap of 32 s and jitter',
    source: '§16.5: engine retry behavior, exponential wait from 500 ms, cap 32 s, jitter',
    kind: 'advisory',
    scenario: 'rf-retry',
    verify: retryTiming,
  },
  {
    id: 'rf-retry-cutoff',
    title: 'A retry-after above 60 s ends the retries',
    source: '§16.5: engine retry behavior, a retry-after above 60 s ends the retries',
    kind: 'advisory',
    scenario: 'rf-retry',
    verify: retryCutoff,
  },
  {
    id: 'rf-retry-agent',
    title: 'An agent gets full retries on 529',
    source: '§16.5: engine retry behavior, an agent gets full retries on 529',
    kind: 'advisory',
    scenario: 'rf-retry',
    verify: retryAgent,
  },
  {
    id: 'rf-opus-fallback',
    title: 'An Opus agent falls back to another model after 3 529 errors',
    source: '§16.5: engine retry behavior, an Opus agent falls back after 3 529 errors',
    kind: 'advisory',
    scenario: 'rf-fallback',
    verify: opusFallback,
  },
  {
    id: 'rf-tasks-stop',
    title: '/tasks stop acts like ctrl+x ctrl+k twice',
    source: '§16.5: engine retry behavior, /tasks stop acts like ctrl+x ctrl+k twice',
    kind: 'advisory',
    scenario: 'rf-tasks',
    verify: tasksStop,
  },
  {
    id: 'rf-limit',
    title: 'A real subscription limit sets limited with its row and keeps the backlog',
    source: '§16.5: failure rows of a real account, a real subscription limit',
    kind: 'deterministic',
    scenario: 'rf-limit',
    needs: ['account:limit'],
    verify: limitKept,
  },
  {
    id: 'rf-billing',
    title: 'A real billing_error row has Credit balance is too low and halts at once',
    source: '§16.5: failure rows of a real account, a real billing_error row (§16.4 #9)',
    kind: 'deterministic',
    scenario: 'rf-billing',
    needs: ['account:billing'],
    verify: billingHalt,
  },
  {
    id: 'rf-too-long',
    title: 'Prompt is too long at a later agent step keeps the notes and counts no failure',
    source: '§16.5: failure rows of a real account, Prompt is too long at a later agent step',
    kind: 'deterministic',
    scenario: 'rf-too-long',
    needs: ['account:api-key'],
    verify: tooLongKept,
  },
  {
    id: 'rf-opus-529',
    title: '3 consecutive 529s on Opus, API-key account, end with Repeated 529 Overloaded errors',
    source: '§16.5: failure rows of a real account, 3 consecutive 529 errors on Opus (§12.1)',
    kind: 'deterministic',
    scenario: 'rf-opus',
    needs: ['account:api-key'],
    verify: opusEarlyEnd,
  },
];
