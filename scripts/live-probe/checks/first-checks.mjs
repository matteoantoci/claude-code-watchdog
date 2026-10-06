// §16.4: the 11 first checks, each with the 2.1.290 result of its row. The shared scenarios (checks/shared.mjs) show
// the facts the observer already logs; the scenarios here force each other action with a probe mod (mods/fc-*), the
// proxy, or a prompt that names the one tool call to make. Never edit the plugin.
import fs from 'node:fs';
import path from 'node:path';
import { SETTING_SOURCES_WITH_USER, sleep } from '../lib/env.mjs';
import { readTranscript } from '../lib/files.mjs';
import { assistantText, pluginDirs, runHeadless } from '../lib/headless.mjs';
import {
  agentTurnCompletes,
  mainTurnCompletes,
  ofEvent,
  readObs,
  waitObs,
  watchdogAgentIds,
  watchdogSpawns,
} from '../lib/observe.mjs';
import { startProxy } from '../lib/proxy-ctl.mjs';
import { createRun, readJsonLines, readText, writeProjectFiles } from '../lib/run.mjs';
import { startTui, watchDialogs } from '../lib/tui.mjs';
import {
  INLINE_KEY,
  readUserSettings,
  userPluginsOff,
  withUserSettings,
  writeUserSettings,
} from '../lib/user-settings.mjs';
import { clip, expectAll, fail, inconclusive, pass } from '../lib/verdict.mjs';
import { probeRoster } from './shared.mjs';

// §16.4 item 1: the id of a plugin spawn's synthetic Agent call, and its input keys.
const PLUGIN_ID = /^toolu_plugin_[0-9a-f]{32}$/u;
const SPAWN_KEYS = ['prompt', 'description', 'run_in_background', 'subagent_type', 'tool', 'tool_use_id'];

// §16.4 item 3: the slow plugin agent of mods/fc-fork; the TUI forks its summary agent 30.0 to 30.1 s after it.
const FORK_PROMPT = 'WDGO. Reply with the single word OK. Do not use tools.';
const FORK_WAIT_MS = 36_000;
const FORK_MS = 30_000;
const SUMMARY_LINE = /\[AgentSummary\]|agent_summary/u;
const FORK_LINE = /\[AgentSummary\] Forking for summary|source=agent_summary/u;
// §4.5: the events whose order §16.4 item 6 states (mods/fc-fork logs the events before session.start).
const LIFECYCLE = ['command.describe', 'ui.render', 'session.start'];

// §16.4 item 4: the code words of mods/fc-hold; the prompts name only their prefix, so a hit is the hook's context.
const HOLD_MARKER = 'FCHOLD-ZEBRA8';
const CATCH_MARKER = 'FCSPIN-CATCH7';
const SPIN_HOOK_MARKER = 'FCSPIN-HOOK0';
const agentPrompt = (extra, prefix) =>
  'This is a plugin test. A plugin may add a harmless test code word to the Agent tool result. Call the Agent ' +
  `tool exactly once${extra}, with subagent_type "general-purpose", description "ping", and prompt "Reply with the ` +
  'single word PONG. Use no tools." Use no other tool. After the Agent tool returns, reply with exactly one line: ' +
  `PARENT_SAW=<the test code word that starts with ${prefix} in the Agent tool result, or NONE>.`;
const HOLD_PROMPT = agentPrompt('', 'FCHOLD-');
const SPIN_PROMPT = agentPrompt('', 'FCSPIN-');
// §16.4 item 4: the TUI runs every Agent call in the background, also when the call asks for the foreground.
const HOLD_TUI_PROMPT = agentPrompt(' with run_in_background set to false', 'FCHOLD-');
const REJECTED = "doesn't want to proceed";

// §16.4 item 7: in each review the watchdog calls Read, Grep and Glob outside the cwd (the calls of
// prototypes/first-checks/read-outside), then reads math.js. OUTSIDE_PATHS is the path each tool's call names, which
// the plugin's deny text names too. The main loop reads MAIN_OUTSIDE (another path, so the §6.5 allow set of the main
// loop's read does not cover the watchdog's calls).
const OUTSIDE = '/etc/hosts';
const OUTSIDE_DIR = '/etc';
const OUTSIDE_PATHS = { Read: OUTSIDE, Grep: OUTSIDE, Glob: OUTSIDE_DIR };
const MAIN_OUTSIDE = '/etc/shells';
const OUTSIDE_INSTRUCTIONS =
  'In every review, make the four calls below, one call at a time, and do not retry a denied call. ' +
  `First call Read on the absolute file ${OUTSIDE}. Then call Grep with pattern "localhost" and path ` +
  `"${OUTSIDE}". Then call Glob with pattern "hosts" and path "${OUTSIDE_DIR}". Then call Read on math.js in the ` +
  'working directory. Then call note once with severity concern and a one-line text that starts with WDPROBE and ' +
  'names which calls were denied. Then end the review with done.';
const OUTSIDE_P_PROMPT =
  'Read math.js with the Read tool and reply in one line what add returns. Do not read any other file.';
const OUTSIDE_TUI_PROMPT =
  `Read ${MAIN_OUTSIDE} with the Read tool, then read math.js, one tool call at a time. Then reply in one line ` +
  'what add returns.';
// §16.4 item 7, plan mode: the main loop must not leave plan mode (prototypes/first-checks/read-outside, tui-plan-*).
const PLAN_PREFIX = 'This is not a planning task: do not write a plan and do not call ExitPlanMode. ';
// §6.5 item 6: the start of the plugin's deny text (plugins/watchdog/hooks/tools/scope.ts readScopeDeny).
const SCOPE_DENY = 'Outside the watchdog read scope: ';
const WATCHDOG_DIALOG = /from the watchdog plugin/iu;

// §7.1: the fields of a response row and of its message (research/first-checks.md item 8).
const ROW_KEYS = ['message', 'door', 'origin', 'uuid'];
const MESSAGE_KEYS = ['type', 'role', 'content'];

// §16.4 item 9, §12.2: the Anthropic message for an empty balance and the row text the client makes of it.
const BILLING_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or ' +
  'purchase credits.';
const BILLING_ROW = 'Credit balance is too low';
const BILLING_TUI = 'Credit balance too low';

// §16.4 item 10: `/watchdog` parses exact subcommands (§5.1), so `on <prompt>` gets the usage reply
// (plugins/watchdog/hooks/command/spec.ts USAGE_REPLY).
const PON_PROMPT = '/watchdog on Read math.js and reply with the one word DONE';
const USAGE_REPLY = 'usage: /watchdog [on|off|status|dump [raw]]';

// §16.4 item 11: the `userConfig` key of mods/fc-reload.
const RELOAD_KEY = 'fcreload@inline';

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const plain = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/gu, '');

// A multi-line reply as one evidence line.
const oneLine = (text) => String(text ?? '').replaceAll('\n', ' | ');

const modLog = (run, name) => readJsonLines(path.join(run.logs, name));

// A mod that reloads (or whose worker respawns) logs one file per module instance: <prefix>-<instance>.jsonl.
const instanceLogs = (run, prefix) =>
  fs
    .readdirSync(run.logs)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl'))
    .flatMap((name) => readJsonLines(path.join(run.logs, name)))
    .sort((a, b) => a.t - b.t);

// Polls `test()` until it returns a truthy value or the time is up; resolves that value (or the last falsy one).
const poll = async (test, { timeoutMs, intervalMs = 1000 }) => {
  const begin = Date.now();
  for (;;) {
    const value = test();
    if (value || Date.now() - begin > timeoutMs) {
      return value;
    }
    await sleep(intervalMs);
  }
};

// The `result` messages a stream-json `-p` session wrote so far: one for each main turn.
const resultCount = (run, label) =>
  readJsonLines(path.join(run.logs, `${label}.jsonl`)).filter((event) => event.type === 'result').length;

const debugLines = (file, pattern) =>
  readText(file)
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());

// The epoch time of a debug line, which starts with an ISO time.
const lineMs = (line) => Date.parse(String(line).split(' ')[0]);

// The reply of a `/watchdog <args>` command after `after`, as the observer saw it (`command.run.out`).
const commandOut = (events, args, after) =>
  ofEvent(
    events,
    'command.run.out',
    (event) => event.command === 'watchdog' && event.args === args && event.t >= after
  )[0];

// §16.4 item 1: the synthetic `tool.call` `Agent` of each plugin spawn.
const syntheticIns = (events) =>
  ofEvent(events, 'tool.call.in', (event) => event.tool === 'Agent' && PLUGIN_ID.test(event.tool_use_id ?? ''));

const agentIdOf = (result) =>
  json(result)?.result?.agentId ?? String(result ?? '').match(/"agentId":"(a[0-9a-f]+)"/u)?.[1] ?? null;

// §16.4 item 1, §7.3 item 5: the facts of one synthetic call. The observer clips the input at 1500 characters and
// the prompt comes first, so `subagent_type` and `run_in_background` fall back to the `agent.spawn` event of the
// same `tool_use_id`.
const syntheticFacts = (call, events) => {
  const spawnIn = ofEvent(events, 'agent.spawn.in', (event) => event.tool_use_id === call.tool_use_id)[0];
  const out = ofEvent(events, 'tool.call.out', (event) => event.tool_use_id === call.tool_use_id)[0];
  const spawnOut = spawnIn
    ? ofEvent(
        events,
        'agent.spawn.out',
        (event) => event.t >= spawnIn.t && event.subagentType === spawnIn.subagentType
      )[0]
    : undefined;
  const typeText = String(call.input).match(/"subagent_type":"([^"]+)"/u)?.[1];
  const backgroundText = String(call.input).match(/"run_in_background":(true|false)/u)?.[1];
  return {
    id: call.tool_use_id,
    subagentType: typeText ?? spawnIn?.subagentType ?? null,
    background: backgroundText === undefined ? (spawnIn?.background ?? null) : backgroundText === 'true',
    from: typeText && backgroundText ? 'input' : 'agent.spawn.in',
    isFirst: Boolean(spawnIn) && call.t <= spawnIn.t,
    resultId: agentIdOf(out?.result),
    spawnId: spawnOut?.result?.agentId ?? null,
  };
};

const factText = (fact) => `${fact.id.slice(-8)} ${fact.subagentType} bg=${fact.background} via ${fact.from}`;

// §16.4 item 2: every list read the observer logged (3 s of polls after each spawn, and one at each main turn end).
const listReads = (events) => [...ofEvent(events, 'agent.list.poll'), ...ofEvent(events, 'agent.list')];

// §16.4 item 3: one list read of mods/fc-fork, as `+<ms>: <ids>`.
const listText = (read) => `+${read.atMs}: ${read.error ?? (read.entries ?? []).map((agent) => agent.id).join(',')}`;

// §16.4 item 6: watchdog spawns in a main turn that also ran a resolved register before the spawn.
const sameTurnSpawns = (events) => {
  const regs = ofEvent(events, 'agent.register', (event) => String(event.result ?? '').includes('watchdog:'));
  return ofEvent(events, 'agent.spawn.out', (event) => String(event.subagentType).startsWith('watchdog:')).filter(
    (spawn) => {
      const start = ofEvent(events, 'turn.start', (event) => !event.agentId && event.t <= spawn.t).at(-1);
      const ended = ofEvent(
        events,
        'turn.complete',
        (event) => !event.agentId && start && event.t > start.t && event.t < spawn.t
      );
      return start && ended.length === 0 && regs.some((reg) => reg.t >= start.t && reg.t <= spawn.t);
    }
  );
};

// §16.4 item 8: the main response rows between one main `turn.step` and the next step or the turn end.
const responseWindows = (events) => {
  const windows = [];
  let step = null;
  for (const event of events) {
    if (event.agentId) {
      continue;
    }
    if (event.ev === 'turn.step') {
      step = { index: event.index, t: event.t, rows: [] };
      windows.push(step);
    } else if (event.ev === 'turn.complete') {
      step = null;
    } else if (event.ev === 'session.append' && event.door === 'response' && step) {
      step.rows.push(event);
    } else if (event.ev === 'session.append' && event.door === 'response') {
      windows.push({ index: null, t: event.t, rows: [event] });
    }
  }
  return windows;
};

const blockIds = (events, pattern) =>
  ofEvent(events, 'session.append', (event) => !event.agentId)
    .flatMap((event) => event.blocks ?? [])
    .map((block) => String(block).match(pattern)?.[1])
    .filter(Boolean);

// §7.6: the lengths of the main loop's thinking blocks (the observer logs `thinking:<length>`).
const thinkingLengths = (events) => blockIds(events, /^thinking:(\d+)$/u).map(Number);

// §16.4 item 4: the saved request bodies whose messages hold a `tool_result` block with `marker` (the wire proof).
const markerInBodies = (bodies, marker) =>
  bodies.filter((item) =>
    (item.body?.messages ?? []).some((message) =>
      (Array.isArray(message.content) ? message.content : []).some(
        (block) => block?.type === 'tool_result' && JSON.stringify(block).includes(marker)
      )
    )
  );

// §16.4 item 4: the transcript rows that hold a `tool_result` for `id` whose text includes `phrase`.
const toolResultRows = (transcript, id, phrase) =>
  transcript.filter((row) =>
    (Array.isArray(row?.message?.content) ? row.message.content : []).some(
      (block) => block?.type === 'tool_result' && block.tool_use_id === id && JSON.stringify(block).includes(phrase)
    )
  );

const decision = (result) => json(result)?.decision ?? null;

// §16.4 item 7, §6.5: the engine verdicts (mods/fc-scope) and the final verdicts (observer) of the watchdog's `tool`
// calls on OUTSIDE_PATHS[tool]. A watchdog call is one with origin `watchdog`, so a check without `agentId` still
// counts.
const scopeFacts = (label, tool, scope, events) => {
  const ids = watchdogAgentIds(events);
  const target = OUTSIDE_PATHS[tool];
  const engine = scope.filter(
    (event) =>
      event.ev === 'engine' &&
      event.tool === tool &&
      event.origin?.plugin === 'watchdog' &&
      String(event.input).includes(target)
  );
  const final = ofEvent(
    events,
    'tool.check',
    (event) => event.tool === tool && event.origin?.plugin === 'watchdog' && String(event.input).includes(target)
  );
  const reasons = final.map((event) => String(json(event.result)?.reason ?? ''));
  return {
    isTried: engine.length > 0 || final.length > 0,
    conditions: {
      [`${label}: the engine verdict is ask`]: engine.length > 0 && engine.every((event) => event.decision === 'ask'),
      [`${label}: each watchdog tool.check has agentId = the spawn id`]:
        engine.length > 0 &&
        engine.every((event) => event.hasAgentId && ids.has(event.agentId)) &&
        final.every((event) => ids.has(event.agentId)),
      [`${label}: the plugin denies with the §6.5 text`]:
        final.length > 0 &&
        final.every((event) => decision(event.result) === 'deny') &&
        reasons.every((reason) => reason.startsWith(SCOPE_DENY) && reason.includes(target)),
    },
    lines: [
      `${label}: engine ${engine.map((event) => `${event.decision} agentId=${event.agentId}`).join(', ') || 'none'}`,
      `${label}: plugin ${final.map((event) => decision(event.result)).join(',') || 'none'} ` +
        clip(reasons[0] ?? '', 120),
      `${label}: reviews ended ${agentTurnCompletes(events).length}`,
    ],
  };
};

// §16.4 item 3: the slow agent's spawn, and whether it lived 30 s (else no fork can show).
const forkLife = (obs) => {
  const spawn = ofEvent(obs.events, 'agent.spawn.out')[0];
  const agentId = spawn?.result?.agentId ?? null;
  const done = agentId ? ofEvent(obs.events, 'turn.complete', (event) => event.agentId === agentId)[0] : undefined;
  return { spawn, agentId, ranMs: done ? done.t - spawn.t : null, isAlive: !done || done.t - spawn.t >= FORK_MS };
};

// §4.5, §16.4 item 6: what mods/fc-fork saw before `session.start`.
const loadFacts = (log) => {
  const order = log.find((event) => event.ev === 'order')?.events ?? [];
  const call = log.find((event) => event.ev === 'first.register.call');
  const load = log.find((event) => event.ev === 'load');
  const create = log.find((event) => event.ev === 'engine.create');
  return {
    order,
    first: order.find((ev) => LIFECYCLE.includes(ev)) ?? null,
    call,
    ok: log.find((event) => event.ev === 'first.register.ok'),
    error: log.find((event) => event.ev === 'first.register.err'),
    hasNoDollar:
      Boolean(load) &&
      !load.hasGlobalDollar &&
      !(load.args ?? []).some((arg) => Array.isArray(arg) && arg.includes('agent')) &&
      create?.call !== 'resolved',
    lines: [
      `events before session.start: ${clip(order.join(' '), 240)}`,
      `load args ${clip(load?.args, 80)} global $ ${load?.hasGlobalDollar}; ` +
        `engine.create ${clip(create?.call ?? 'not seen', 120)}`,
    ],
  };
};

// §16.4 item 3: a -p session with the slow agent of mods/fc-fork, killed 36 s after the spawn.
const forkHeadless = async (ctx) => {
  const run = createRun(ctx, 'fc3-fork-p');
  const p = await runHeadless(run, {
    label: 'p',
    plugins: pluginDirs(run, { watchdog: false, mods: ['fc-fork'] }),
    args: ['--allowedTools', 'Bash'],
    timeoutMs: 150_000,
    closeAfterMs: 1000,
    input: async (send, child) => {
      send(FORK_PROMPT);
      const spawned = await waitObs(run, (events) => ofEvent(events, 'agent.spawn.out')[0], { timeoutMs: 60_000 });
      if (spawned.ok) {
        await sleep(FORK_WAIT_MS);
      }
      child.kill('SIGTERM');
    },
  });
  await sleep(1000);
  return {
    run,
    p,
    events: readObs(run),
    log: modLog(run, 'fc-fork.jsonl'),
    summary: debugLines(p.debugFile, SUMMARY_LINE),
  };
};

// §16.4 item 3: the same in the TUI, which forks the summary agent.
const forkTui = async (ctx) => {
  const run = createRun(ctx, 'fc3-fork-tui');
  const tui = await startTui(run, {
    label: 'tui',
    plugins: pluginDirs(run, { watchdog: false, mods: ['fc-fork'] }),
    args: ['--allowedTools', 'Bash'],
  });
  try {
    await tui.type(FORK_PROMPT);
    const spawned = await waitObs(run, (events) => ofEvent(events, 'agent.spawn.out')[0], { timeoutMs: 60_000 });
    if (spawned.ok) {
      await sleep(FORK_WAIT_MS);
    }
    tui.capture('after-fork');
    return {
      run,
      events: readObs(run),
      log: modLog(run, 'fc-fork.jsonl'),
      summary: debugLines(tui.debugFile, SUMMARY_LINE),
    };
  } finally {
    await tui.stop();
  }
};

// §16.4 item 4: a -p session through the proxy (wire proof) with a foreground Agent call: prompt 1 holds 8 s, prompt 2
// spins the hooks worker. No observer: the worker respawn of the spin would drop the observer's hook in flight.
const holdHeadless = async (ctx) => {
  const run = createRun(ctx, 'fc4-hold-p');
  const proxy = await startProxy(run, { saveBodies: true });
  try {
    const p = await runHeadless(run, {
      label: 'p',
      plugins: pluginDirs(run, { observer: false, watchdog: false, mods: ['fc-hold'] }),
      env: { ...proxy.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      args: ['--allowedTools', 'Agent'],
      timeoutMs: 240_000,
      closeAfterMs: 2000,
      input: async (send) => {
        send(HOLD_PROMPT);
        await poll(() => resultCount(run, 'p') >= 1, { timeoutMs: 100_000 });
        send(SPIN_PROMPT);
        await poll(() => resultCount(run, 'p') >= 2, { timeoutMs: 100_000 });
      },
    });
    return {
      run,
      p,
      log: instanceLogs(run, 'fc-hold'),
      bodies: proxy.bodies(),
      text: assistantText(p.events),
      debug: debugLines(p.debugFile, /hooks worker|\.catch/u),
    };
  } finally {
    proxy.stop();
  }
};

// §16.4 item 4: the default TUI (background Agent calls); Esc 0.5 s into the 8 s hold.
const holdTui = async (ctx) => {
  const run = createRun(ctx, 'fc4-hold-tui');
  const tui = await startTui(run, {
    label: 'tui',
    plugins: pluginDirs(run, { watchdog: false, mods: ['fc-hold'] }),
    args: ['--allowedTools', 'Agent'],
  });
  try {
    await tui.type(HOLD_TUI_PROMPT);
    const held = await poll(
      () => instanceLogs(run, 'fc-hold').find((event) => event.ev === 'call.next' && event.mode === 'hold'),
      { timeoutMs: 90_000, intervalMs: 250 }
    );
    if (held) {
      await sleep(500);
      await tui.keys('Escape');
    }
    await sleep(1500);
    tui.capture('after-esc');
    await tui.waitIdle({ timeoutMs: 60_000 });
    const events = readObs(run);
    const sessionId = ofEvent(events, 'session.start').at(-1)?.sessionId ?? null;
    return { run, events, log: instanceLogs(run, 'fc-hold'), transcript: readTranscript(sessionId), held };
  } finally {
    await tui.stop();
  }
};

// §16.4 item 5: a TUI session (as the research ran it) with mods/fc-submit alone, so no other plugin's hook sits in
// the dispatches; 4 main turns: the person's prompt and the yield, none and clock submits.
const submitTui = async (ctx) => {
  const run = createRun(ctx, 'fc5-submit');
  const tui = await startTui(run, {
    label: 'tui',
    plugins: pluginDirs(run, { observer: false, watchdog: false, mods: ['fc-submit'] }),
  });
  try {
    await tui.type('Reply with exactly one word: OK');
    await poll(() => modLog(run, 'fc-submit.jsonl').some((event) => event.ev === 'complete' && event.n >= 4), {
      timeoutMs: 90_000,
    });
    await tui.waitIdle({ timeoutMs: 30_000 });
    return { run, log: modLog(run, 'fc-submit.jsonl') };
  } finally {
    await tui.stop();
  }
};

// §16.4 item 7: the `--permission-mode` flags and the prompt prefix of a default or a plan-mode fc7 session.
const modeArgs = (mode) => (mode === 'plan' ? ['--permission-mode', 'plan'] : []);
const modePrompt = (mode, prompt) => (mode === 'plan' ? `${PLAN_PREFIX}${prompt}` : prompt);

// The permission mode a TUI started in, from its footer `⏸ <mode> mode on` (`manual` is the default mode).
const tuiMode = (screen) => /⏸ (\w+) mode on/u.exec(screen)?.[1] ?? 'unknown';

// §16.4 items 7 and 8: CLAUDE_WATCHDOG=on -p in `mode`; the watchdog reads, greps and globs OUTSIDE_PATHS, then reads
// math.js. No --allowedTools: a rule `Read` would allow every path. --thinking-display summarized gives -p thinking
// text.
const outsideHeadless = async (ctx, { id, mode }) => {
  const run = createRun(ctx, id, {
    files: { 'WATCHDOG.json': probeRoster({ instructions: OUTSIDE_INSTRUCTIONS }) },
  });
  const p = await runHeadless(run, {
    label: 'p',
    env: { CLAUDE_WATCHDOG: 'on' },
    args: ['--thinking-display', 'summarized', ...modeArgs(mode)],
    plugins: pluginDirs(run, { mods: ['fc-scope'] }),
    timeoutMs: 200_000,
    closeAfterMs: 5000,
    input: async (send) => {
      send(modePrompt(mode, OUTSIDE_P_PROMPT));
      await waitObs(run, (events) => agentTurnCompletes(events).length >= 1, { timeoutMs: 150_000 });
    },
  });
  await sleep(1000);
  return {
    run,
    p,
    mode: p.init?.permissionMode ?? 'no init',
    events: readObs(run),
    scope: modLog(run, 'fc-scope.jsonl'),
  };
};

// §16.4 item 7: the TUI in `mode`; the main loop reads MAIN_OUTSIDE (a dialog, answered Yes) and math.js, the watchdog
// reads, greps and globs OUTSIDE_PATHS. Each dialog on screen is kept.
const outsideTui = async (ctx, { id, mode }) => {
  const run = createRun(ctx, id, {
    files: { 'WATCHDOG.json': probeRoster({ instructions: OUTSIDE_INSTRUCTIONS }) },
  });
  const tui = await startTui(run, {
    label: 'tui',
    plugins: pluginDirs(run, { mods: ['fc-scope'] }),
    args: modeArgs(mode),
  });
  try {
    const started = tuiMode(tui.screen());
    const began = Date.now();
    await tui.type('/watchdog on');
    await waitObs(run, (events) => commandOut(events, 'on', began), { timeoutMs: 30_000 });
    await tui.type(modePrompt(mode, OUTSIDE_TUI_PROMPT));
    const dialogs = await watchDialogs(tui, {
      answer: 'Enter',
      timeoutMs: 160_000,
      until: async () => agentTurnCompletes(readObs(run)).length >= 1,
    });
    await tui.waitIdle({ timeoutMs: 60_000 });
    return { run, mode: started, events: readObs(run), scope: modLog(run, 'fc-scope.jsonl'), dialogs };
  } finally {
    await tui.stop();
  }
};

// §16.4 item 9: the proxy answers each watchdog request with a 400 billing_error; the main loop goes through.
const billingHeadless = async (ctx) => {
  const run = createRun(ctx, 'fc9-billing', { files: { 'WATCHDOG.json': probeRoster() } });
  const proxy = await startProxy(run, {
    agent: 400,
    errType: 'billing_error',
    message: BILLING_MESSAGE,
    shouldRetry: null,
  });
  try {
    const p = await runHeadless(run, {
      label: 'p',
      env: { ...proxy.env, CLAUDE_WATCHDOG: 'on' },
      plugins: pluginDirs(run),
      timeoutMs: 180_000,
      closeAfterMs: 5000,
      input: async (send) => {
        send('Read math.js with the Read tool and reply in one line what add returns.');
        await waitObs(run, (events) => agentTurnCompletes(events).some((event) => event.reason === 'error'), {
          timeoutMs: 150_000,
        });
        await sleep(4000);
      },
    });
    await sleep(1000);
    return { run, p, events: readObs(run), proxy: proxy.log() };
  } finally {
    proxy.stop();
  }
};

// §16.4 item 9: the same error on the main loop, as the TUI draws it (no model token is spent).
const billingTui = async (ctx) => {
  const run = createRun(ctx, 'fc9-billing-tui');
  const proxy = await startProxy(run, {
    main: 400,
    errType: 'billing_error',
    message: BILLING_MESSAGE,
    shouldRetry: null,
  });
  try {
    const tui = await startTui(run, { label: 'tui', plugins: pluginDirs(run, { watchdog: false }), env: proxy.env });
    try {
      await tui.type('Reply with the single word PING.');
      const drawn = await tui.waitFor(new RegExp(BILLING_TUI, 'u'), { timeoutMs: 60_000 });
      return { run, drawn: drawn.ok, screen: plain(tui.capture('billing')) };
    } finally {
      await tui.stop();
    }
  } finally {
    proxy.stop();
  }
};

// §16.4 item 10: `claude -p "/watchdog on <prompt>"`.
const commandOnly = async (ctx) => {
  const run = createRun(ctx, 'fc10-pon', { files: { 'WATCHDOG.json': probeRoster() } });
  const p = await runHeadless(run, { label: 'p', prompt: PON_PROMPT, timeoutMs: 120_000 });
  await sleep(1000);
  return { run, p, events: readObs(run) };
};

// §16.4 item 11, §16.3: a TUI that reads user settings (the person's plugins off in settings.local.json). After
// `/watchdog on` and `/fcreload arm`, an outside edit of ~/.claude/settings.json changes the userConfig of the
// watchdog and of mods/fc-reload; `withUserSettings` restores the file byte for byte.
const reloadTui = async (ctx) => {
  const run = createRun(ctx, 'fc11-reload', { files: { 'WATCHDOG.json': probeRoster() } });
  return withUserSettings(run, async () => {
    writeProjectFiles(run, { '.claude/settings.local.json': { enabledPlugins: userPluginsOff() } });
    const storeKey = `fc11:${path.basename(ctx.outDir)}:${run.name}`;
    const tui = await startTui(run, {
      label: 'tui',
      settingSources: SETTING_SOURCES_WITH_USER,
      plugins: pluginDirs(run, { mods: ['fc-reload'], fill: { __STOREKEY__: storeKey } }),
    });
    try {
      const began = Date.now();
      await tui.type('/watchdog on');
      const on = await waitObs(run, (events) => commandOut(events, 'on', began), { timeoutMs: 30_000 });
      await tui.type('/fcreload arm');
      const armed = await poll(() => instanceLogs(run, 'fc-reload').find((event) => event.ev === 'armed'), {
        timeoutMs: 20_000,
        intervalMs: 250,
      });
      const settings = readUserSettings();
      const configs = settings.pluginConfigs ?? {};
      const options = configs[INLINE_KEY]?.options ?? {};
      const immuneTurns = options.immuneTurns === 1 ? 2 : 1;
      writeUserSettings({
        ...settings,
        pluginConfigs: {
          ...configs,
          [INLINE_KEY]: { ...configs[INLINE_KEY], options: { ...options, immuneTurns } },
          [RELOAD_KEY]: { ...configs[RELOAD_KEY], options: { ...configs[RELOAD_KEY]?.options, mark: 2 } },
        },
      });
      const editedAt = Date.now();
      await poll(() => new Set(instanceLogs(run, 'fc-reload').map((event) => event.inst)).size >= 2, {
        timeoutMs: 25_000,
      });
      const bothRows = (text) => /watchdog: options changed/u.test(text) && /fcreload: options changed/u.test(text);
      const rows = await tui.waitFor(bothRows, {
        timeoutMs: 15_000,
      });
      tui.capture('reloaded');
      const statusAt = Date.now();
      await tui.type('/watchdog status');
      const status = await waitObs(run, (events) => commandOut(events, 'status', statusAt), { timeoutMs: 30_000 });
      // §14.6: wait past the due time of the old instance's after timer, and for the new instance's control timer.
      const due = (armed?.t ?? editedAt) + (armed?.afterMs ?? 12_000) + 3000;
      await sleep(Math.min(Math.max(0, due - Date.now()), 20_000));
      await poll(() => instanceLogs(run, 'fc-reload').some((event) => event.ev === 'control.fire'), {
        timeoutMs: 8000,
      });
      const screen = tui.capture('end-wait');
      return {
        run,
        events: readObs(run),
        log: instanceLogs(run, 'fc-reload'),
        on: on.value ?? null,
        status: status.value ?? null,
        screen: plain(`${rows.text}\n${screen}`),
        immuneTurns,
        editedAt,
      };
    } finally {
      await tui.stop();
    }
  });
};

export const scenarios = [
  {
    id: 'fc3-fork-p',
    title: '-p session with a slow plugin agent kept past 30 s; the debug file shows whether a summary fork ran',
    needs: [],
    run: (ctx) => forkHeadless(ctx),
  },
  {
    id: 'fc3-fork-tui',
    title: 'TUI session with a slow plugin agent kept past 30 s; the debug file shows the summary fork',
    needs: ['tui'],
    run: (ctx) => forkTui(ctx),
  },
  {
    id: 'fc4-hold-p',
    title: '-p session through the proxy: 8 s hold on the main Agent tool.call, then a worker spin answered by .catch',
    needs: ['proxy'],
    run: (ctx) => holdHeadless(ctx),
  },
  {
    id: 'fc4-hold-tui',
    title: 'Default TUI: a background Agent call held 8 s, Esc during the hold',
    needs: ['tui'],
    run: (ctx) => holdTui(ctx),
  },
  {
    id: 'fc5-submit',
    title: 'TUI: the own prompt.submit hook for a yielded, an unyielded and a $.clock.after submit',
    needs: ['tui'],
    run: (ctx) => submitTui(ctx),
  },
  {
    id: 'fc7-outside-p',
    title: 'CLAUDE_WATCHDOG=on -p: the watchdog reads and greps /etc/hosts, globs /etc; thinking summaries on',
    needs: [],
    run: (ctx) => outsideHeadless(ctx, { id: 'fc7-outside-p', mode: 'default' }),
  },
  {
    id: 'fc7-outside-tui',
    title: 'TUI: the main loop reads /etc/shells (dialog), the watchdog reads and greps /etc/hosts, globs /etc',
    needs: ['tui'],
    run: (ctx) => outsideTui(ctx, { id: 'fc7-outside-tui', mode: 'default' }),
  },
  {
    id: 'fc7-plan-p',
    title: 'Plan-mode CLAUDE_WATCHDOG=on -p: the watchdog reads and greps /etc/hosts, globs /etc',
    needs: [],
    run: (ctx) => outsideHeadless(ctx, { id: 'fc7-plan-p', mode: 'plan' }),
  },
  {
    id: 'fc7-plan-tui',
    title:
      'Plan-mode TUI: the main loop reads /etc/shells (dialog), the watchdog reads and greps /etc/hosts, globs /etc',
    needs: ['tui'],
    run: (ctx) => outsideTui(ctx, { id: 'fc7-plan-tui', mode: 'plan' }),
  },
  {
    id: 'fc9-billing',
    title: 'Proxy 400 billing_error on each watchdog request of a CLAUDE_WATCHDOG=on -p session',
    needs: ['proxy'],
    run: (ctx) => billingHeadless(ctx),
  },
  {
    id: 'fc9-billing-tui',
    title: 'Proxy 400 billing_error on the main loop of a TUI session',
    needs: ['tui', 'proxy'],
    run: (ctx) => billingTui(ctx),
  },
  {
    id: 'fc10-pon',
    title: 'claude -p "/watchdog on <prompt>"',
    needs: [],
    run: (ctx) => commandOnly(ctx),
  },
  {
    id: 'fc11-reload',
    title: 'TUI with user settings: an outside edit of ~/.claude/settings.json reloads the watchdog and mods/fc-reload',
    needs: ['tui', 'user-settings'],
    run: (ctx) => reloadTui(ctx),
  },
];

// §16.4 item 7, §6.5: the check of one watchdog read tool (Read, Grep, Glob) in one fc7 scenario (`surface` p or tui,
// `mode` default or plan). Each watchdog call of `tool` outside the cwd is an engine ask with the spawn's agentId and
// gets the plugin's §6.5 deny; in the TUI no dialog opens for it. A plan-mode session must start in plan mode, and a
// main-loop ExitPlanMode call makes the check inconclusive, since the session may have left plan mode.
const scopeCheck = ({ tool, surface, mode }) => {
  const isTui = surface === 'tui';
  const isPlan = mode === 'plan';
  const label = `${isPlan ? 'plan ' : ''}${isTui ? 'tui' : '-p'}`;
  return {
    id: `fc7-scope-${isPlan ? 'plan-' : ''}${tool.toLowerCase()}-${surface}`,
    title:
      `In ${isTui ? 'the TUI' : '-p'}${isPlan ? ' in plan mode' : ''} a watchdog ${tool} outside the cwd is an ` +
      `engine ask with agentId, and the plugin denies it with the §6.5 text${isTui ? ', and no dialog opens' : ''}`,
    source: '§16.4 #7',
    kind: 'deterministic',
    scenario: `fc7-${isPlan ? 'plan' : 'outside'}-${surface}`,
    verify: (obs) => {
      const facts = scopeFacts(label, tool, obs.scope, obs.events);
      const evidence = [...facts.lines, `${label}: permission mode at start ${obs.mode}`];
      if (!facts.isTried) {
        return inconclusive([`the watchdog never called ${tool} on ${OUTSIDE_PATHS[tool]}`, ...evidence, obs.run.logs]);
      }
      const exits = ofEvent(obs.events, 'tool.check', (event) => event.tool === 'ExitPlanMode');
      if (isPlan && exits.length > 0) {
        return inconclusive([
          `the main loop called ExitPlanMode ${exits.length} times, so it may have left plan mode`,
          ...evidence,
          obs.run.logs,
        ]);
      }
      const dialogs = isTui ? obs.dialogs.filter((dialog) => WATCHDOG_DIALOG.test(dialog.text)) : [];
      return expectAll(
        {
          ...(isPlan ? { [`${label}: the session started in plan mode`]: obs.mode === 'plan' } : {}),
          ...facts.conditions,
          ...(isTui ? { [`${label}: no dialog for the watchdog calls`]: dialogs.length === 0 } : {}),
        },
        [
          ...evidence,
          ...(isTui ? [`dialogs ${obs.dialogs.length}, from the watchdog plugin ${dialogs.length}`] : []),
          obs.run.logs,
        ]
      );
    },
  };
};

export const checks = [
  {
    id: 'fc1-synthetic',
    title:
      'A plugin spawn fires a synthetic Agent tool.call before agent.spawn: origin watchdog/user, no agentId, ' +
      'toolu_plugin_ + 32 hex, subagent_type watchdog:<name>, run_in_background true, and its next(e) result ' +
      'carries the spawn agentId',
    source: '§16.4 #1',
    kind: 'deterministic',
    scenario: 'headless-review',
    verify: (obs) => {
      const calls = syntheticIns(obs.events);
      if (calls.length === 0) {
        return watchdogSpawns(obs.events).length === 0
          ? inconclusive(['no watchdog spawn, so no synthetic Agent call', obs.run.logs])
          : fail(['a watchdog spawn has no synthetic Agent tool.call', obs.run.logs]);
      }
      const facts = calls.map((call) => syntheticFacts(call, obs.events));
      return expectAll(
        {
          'next.origin is { plugin: watchdog, tier: user }': calls.every(
            (call) => call.origin?.plugin === 'watchdog' && call.origin?.tier === 'user'
          ),
          'no agentId on the call': calls.every((call) => call.agentId === null && !call.keys.includes('agentId')),
          'the input has the six spawn keys': calls.every((call) => SPAWN_KEYS.every((key) => call.keys.includes(key))),
          'tool_use_id is toolu_plugin_ + 32 hex': calls.every((call) => PLUGIN_ID.test(call.tool_use_id)),
          'subagent_type is watchdog:<name> and run_in_background is true': facts.every(
            (fact) => String(fact.subagentType).startsWith('watchdog:') && fact.background === true
          ),
          'the call fires before agent.spawn': facts.every((fact) => fact.isFirst),
          'its next(e) result agentId is the spawn agentId': facts.every(
            (fact) => fact.resultId !== null && fact.resultId === fact.spawnId
          ),
        },
        [
          clip(facts.map(factText).join('; ')),
          clip(facts.map((fact) => `${fact.id.slice(-8)} result=${fact.resultId} spawn=${fact.spawnId}`).join('; ')),
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc2-list-id',
    title: '$.agent.list() names each spawn by the field id with spawnedBy watchdog',
    source: '§16.4 #2',
    kind: 'deterministic',
    scenario: 'headless-review',
    verify: (obs) => {
      const spawns = watchdogSpawns(obs.events).filter((spawn) => spawn.agentId);
      if (spawns.length === 0) {
        return inconclusive(['no watchdog spawn', obs.run.logs]);
      }
      const entries = listReads(obs.events).flatMap((read) => read.list ?? []);
      const seen = spawns.map((spawn) => {
        const mine = entries.filter((agent) => agent.id === spawn.agentId);
        return {
          id: spawn.agentId,
          isListed: mine.length > 0,
          isNamed: mine.some((agent) => agent.spawnedBy === 'watchdog'),
        };
      });
      const listed = seen.filter((item) => item.isListed);
      return expectAll(
        {
          'a list entry carries a spawn agentId in the field id': listed.length > 0,
          'each listed spawn shows spawnedBy watchdog': listed.every((item) => item.isNamed),
        },
        [
          `${listed.length}/${spawns.length} spawns listed: ` +
            clip(seen.map((item) => `${item.id} named=${item.isNamed}`).join(' ')),
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc2-list-gap',
    title:
      'spawnedBy is absent from the first list read after the spawn and shows tens of ms later ' +
      '(2.1.290: 34 to 68 ms)',
    source: '§16.4 #2',
    kind: 'advisory',
    scenario: 'headless-review',
    verify: (obs) => {
      const gaps = watchdogSpawns(obs.events).flatMap((spawn) => {
        const polls = ofEvent(obs.events, 'agent.list.poll', (event) => String(event.why).includes(spawn.agentId));
        const first = polls.find((event) => (event.list ?? []).some((agent) => agent.id === spawn.agentId));
        const later = polls.find((event) =>
          (event.list ?? []).some((agent) => agent.id === spawn.agentId && agent.spawnedBy === 'watchdog')
        );
        const early = (first?.list ?? []).find((agent) => agent.id === spawn.agentId);
        return first && later ? [{ id: spawn.agentId, early: early?.spawnedBy ?? null, ms: later.ms }] : [];
      });
      if (gaps.length === 0) {
        return inconclusive(['no spawn had both a first poll and a spawnedBy poll', obs.run.logs]);
      }
      const held = gaps.filter((gap) => gap.early !== 'watchdog');
      return held.length > 0
        ? pass(held.map((gap) => `${gap.id} spawnedBy at poll +${gap.ms}ms, absent on the first poll`))
        : inconclusive(gaps.map((gap) => `${gap.id} first poll already had spawnedBy=${gap.early} (+${gap.ms}ms)`));
    },
  },
  {
    id: 'fc2-first-row',
    title: "The spawned agent's first session.append row comes before $.agent.spawn resolves",
    source: '§16.4 #2',
    kind: 'advisory',
    scenario: 'fc3-fork-p',
    verify: (obs) => {
      // mods/fc-fork logs the resolve of its own $.agent.spawn; the observer logs the agent's rows (same clock).
      const resolved = obs.log.find((event) => event.ev === 'spawn.resolved' && event.agentId);
      if (!resolved) {
        return inconclusive(['the spawn did not resolve with an agentId', obs.run.logs]);
      }
      const row = ofEvent(obs.events, 'session.append', (event) => event.agentId === resolved.agentId)[0];
      return row && row.t <= resolved.t
        ? pass([`first row (${row.door}) ${resolved.t - row.t} ms before the resolve`, obs.run.logs])
        : fail([row ? `first row ${row.t - resolved.t} ms after the resolve` : 'no row of the agent', obs.run.logs]);
    },
  },
  {
    id: 'fc3-nofork-p',
    title: 'A -p session whose plugin agent runs past 30 s has no summary fork',
    source: '§16.4 #3',
    kind: 'advisory',
    scenario: 'fc3-fork-p',
    verify: (obs) => {
      const life = forkLife(obs);
      if (!life.spawn) {
        return inconclusive(['the slow agent never spawned', ...obs.log.map((event) => event.ev), obs.run.logs]);
      }
      if (!life.isAlive) {
        return inconclusive([`the agent ended ${life.ranMs} ms after the spawn, before the fork time`, obs.run.logs]);
      }
      const forks = obs.summary.filter((line) => FORK_LINE.test(line));
      return forks.length === 0
        ? pass([
            `no summary fork in ${obs.p.debugFile}`,
            `agent ${life.ranMs === null ? 'still ran at the kill' : `ended at +${life.ranMs} ms`}`,
          ])
        : fail(['the -p debug file has a summary fork', ...forks.slice(0, 3).map((line) => clip(line, 220))]);
    },
  },
  {
    id: 'fc3-fork-tui',
    title:
      'The TUI forks a summary agent 30.0 to 30.1 s after a plugin spawn, and the fork never shows in ' +
      '$.agent.list()',
    source: '§16.4 #3',
    kind: 'advisory',
    scenario: 'fc3-fork-tui',
    verify: (obs) => {
      const life = forkLife(obs);
      if (!life.spawn) {
        return inconclusive(['the slow agent never spawned', obs.run.logs]);
      }
      if (!life.isAlive) {
        return inconclusive([`the agent ended ${life.ranMs} ms after the spawn, before the fork time`, obs.run.logs]);
      }
      const timer = obs.summary.find((line) => line.includes(`Timer fired for agent ${life.agentId}`));
      const forks = obs.summary.filter((line) => FORK_LINE.test(line));
      const forkMs = timer ? lineMs(timer) - life.spawn.t : null;
      const lists = obs.log.filter((event) => event.ev === 'list');
      const foreign = lists.flatMap((read) => (read.entries ?? []).filter((agent) => agent.id !== life.agentId));
      const calls = ofEvent(obs.events, 'tool.call.in', (event) => event.agentId && event.agentId !== life.agentId);
      return expectAll(
        {
          'the TUI forks a summary agent': forks.length > 0,
          'the fork timer fires 30 s after the spawn (±2 s)': forkMs !== null && Math.abs(forkMs - FORK_MS) <= 2000,
          'list reads after 30 s hold only the spawned agent':
            lists.some((read) => read.entries) && foreign.length === 0,
        },
        [
          `fork timer at +${forkMs} ms; ${forks.length} fork lines; ${clip(forks[0] ?? '', 160)}`,
          `list reads ${clip(lists.map(listText).join(' '), 200)}`,
          `fork tool calls ${calls.length} (2.1.290: 0 of 4; a fork's call has its own agentId)`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc4-context',
    title:
      'An 8 s hold after next(e) of the main Agent tool.call returns context, and the context is in the ' +
      'Agent tool_result the primary reads',
    source: '§16.4 #4',
    kind: 'deterministic',
    scenario: 'fc4-hold-p',
    verify: (obs) => {
      const start = obs.log.find((event) => event.ev === 'call.start' && event.mode === 'hold');
      if (!start) {
        return inconclusive(['the model never called Agent for the hold prompt', obs.run.logs]);
      }
      const end = obs.log.find((event) => event.ev === 'hold.end' && event.id === start.id);
      const hits = markerInBodies(obs.bodies, HOLD_MARKER);
      return expectAll(
        {
          'the 8 s hold ran to its end': end?.how === 'slept',
          'the context is in a later request inside the Agent tool_result': hits.length > 0,
        },
        [
          `hold ${end?.how ?? 'no end line'}; ${HOLD_MARKER} in ${hits.length} of ${obs.bodies.length} requests`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc4-budget',
    title: 'Time inside next(e) does not count against the 10 s budget, and an 8 s hold after it ends with time left',
    source: '§16.4 #4',
    kind: 'deterministic',
    scenario: 'fc4-hold-p',
    verify: (obs) => {
      const after = obs.log.find((event) => event.ev === 'call.next' && event.mode === 'hold');
      if (!after) {
        return inconclusive(['the model never called Agent for the hold prompt', obs.run.logs]);
      }
      const end = obs.log.find((event) => event.ev === 'hold.end' && event.id === after.id);
      return expectAll(
        {
          'at least 9 s of the budget are left after next(e)': Number(after.remainingMs) >= 9000,
          'after the 8 s hold more than 1 s is left': end?.how === 'slept' && Number(end.remainingMs) > 1000,
        },
        [
          `next(e) took ${after.nextMs} ms, ${after.remainingMs} ms left; ` +
            `after the hold ${end?.remainingMs} ms left (2.1.290: 1998)`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc4-marker',
    title: 'The primary repeats the code word of the hook context from the Agent tool_result',
    source: '§16.4 #4',
    kind: 'advisory',
    scenario: 'fc4-hold-p',
    verify: (obs) => {
      const line = obs.text.split('\n').find((item) => item.includes('PARENT_SAW=FCHOLD'));
      return line?.includes(HOLD_MARKER)
        ? pass([clip(line, 200)])
        : inconclusive([`the primary did not repeat ${HOLD_MARKER}`, clip(line ?? obs.text, 200), obs.run.logs]);
    },
  },
  {
    id: 'fc4-catch',
    title:
      'A tool.call hook that keeps the hooks worker busy: the worker is replaced after 5 s and the .catch ' +
      'answers in the new worker, its context reaching the primary',
    source: '§16.4 #4',
    kind: 'deterministic',
    scenario: 'fc4-hold-p',
    verify: (obs) => {
      const start = obs.log.find((event) => event.ev === 'call.start' && event.mode === 'spin');
      if (!start) {
        return inconclusive(['the model never called Agent for the spin prompt', obs.run.logs]);
      }
      const answer = obs.log.find((event) => event.ev === 'catch.answer' && event.id === start.id);
      const respawn = obs.debug.find((line) => /hooks worker.*respawning/u.test(line));
      const hits = markerInBodies(obs.bodies, CATCH_MARKER);
      return expectAll(
        {
          'the busy worker is replaced': Boolean(respawn),
          'the .catch answers in a new module instance': Boolean(answer) && answer.inst !== start.inst,
          'the .catch context is in a later Agent tool_result': hits.length > 0,
        },
        [
          clip(respawn ?? 'no respawn line in the debug file', 220),
          `hook instance ${start.inst}, .catch instance ${answer?.inst ?? 'none'}; ` +
            `${SPIN_HOOK_MARKER} hits ${markerInBodies(obs.bodies, SPIN_HOOK_MARKER).length}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc4-background',
    title:
      'The default TUI runs a main Agent call in the background, also when the call asks for the ' +
      'foreground; next(e) answers with the launch ack',
    source: '§16.4 #4',
    kind: 'deterministic',
    scenario: 'fc4-hold-tui',
    verify: (obs) => {
      const after = obs.log.find((event) => event.ev === 'call.next' && event.mode === 'hold');
      if (!after) {
        return inconclusive(['the model never called Agent', obs.run.logs]);
      }
      const start = obs.log.find((event) => event.ev === 'call.start' && event.id === after.id);
      const spawn = obs.log.find((event) => event.ev === 'spawn' && event.t >= (start?.t ?? 0));
      return expectAll(
        {
          'agent.spawn has background true': spawn?.background === true,
          'next(e) resolves with the async launch, not the report':
            after.isAsync === true ||
            /async_launched/u.test(String(after.status)) ||
            /Async agent launched/iu.test(after.text),
        },
        [
          `asked run_in_background=${start?.runInBackground}; spawn background=${spawn?.background}; ` +
            `next(e) ${after.nextMs} ms`,
          clip(`isAsync=${after.isAsync} status=${after.status} ${after.text}`, 200),
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc4-esc',
    title:
      'Esc during the hold aborts next.signal (user-cancel), the engine drops the hook result, and the ' +
      'transcript replaces the Agent result with a rejection',
    source: '§16.4 #4',
    kind: 'deterministic',
    scenario: 'fc4-hold-tui',
    verify: (obs) => {
      if (!obs.held) {
        return inconclusive(['Esc was not sent: the Agent hold never started', obs.run.logs]);
      }
      const end = obs.log.find((event) => event.ev === 'hold.end' && event.id === obs.held.id);
      const isAborted = Boolean(end) && /user-cancel/u.test(`${end.how} ${end.reason}`);
      const rejected = toolResultRows(obs.transcript, obs.held.id, REJECTED);
      const kept = obs.transcript.filter((row) => JSON.stringify(row).includes(HOLD_MARKER));
      return expectAll(
        {
          'next.signal aborts the hold with user-cancel': isAborted,
          'the transcript Agent result is the rejection': rejected.length > 0,
          'the hook context is dropped': kept.length === 0,
        },
        [
          end ? `hold ${clip(end.how, 80)} after ${end.heldMs} ms, reason ${clip(end.reason, 80)}` : 'no hold.end line',
          `transcript rows ${obs.transcript.length}, rejection rows ${rejected.length}, ` +
            `rows with ${HOLD_MARKER} ${kept.length}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc5-own-submit',
    title:
      "The mod's own prompt.submit hook runs for its submit when the calling hook yields to the host, and " +
      'not for a submit from $.clock.after',
    source: '§16.4 #5',
    kind: 'advisory',
    scenario: 'fc5-submit',
    verify: (obs) => {
      const ran = (variant) => obs.log.some((event) => event.ev === 'own.submit' && event.variant === variant);
      const started = (variant) => obs.log.some((event) => event.ev === 'turn.start' && event.variant === variant);
      const lines = [
        `own hook ran: yield ${ran('yield')}, none ${ran('none')} (2.1.290: 1 of 20 ran), clock ${ran('clock')}`,
        `turns started: yield ${started('yield')}, none ${started('none')}, clock ${started('clock')}`,
        clip(
          obs.log
            .filter((event) => event.ev.startsWith('submit'))
            .map((event) => `${event.ev}:${event.variant}`)
            .join(' '),
          200
        ),
        obs.run.logs,
      ];
      if (!started('yield') || !started('clock')) {
        return inconclusive(['a submit did not start its turn', ...lines]);
      }
      return expectAll(
        {
          'yield to the host: the own hook runs': ran('yield'),
          '$.clock.after: the own hook does not run': !ran('clock'),
        },
        lines
      );
    },
  },
  {
    id: 'fc6-register-p',
    title: 'In -p, $.agent.register resolves in session.start, before the first prompt, and a spawn of the type works',
    source: '§16.4 #6',
    kind: 'deterministic',
    scenario: 'headless-review',
    verify: (obs) => {
      const start = ofEvent(obs.events, 'session.start')[0];
      const prompt = ofEvent(obs.events, 'prompt.submit')[0];
      const errors = ofEvent(obs.events, 'agent.register.error');
      if (!start) {
        return fail(['no session.start', obs.run.logs]);
      }
      const reg = ofEvent(obs.events, 'agent.register').find(
        (event) => event.t >= start.t && (!prompt || event.t <= prompt.t)
      );
      const spawned = watchdogSpawns(obs.events).filter((spawn) => spawn.agentId);
      return expectAll(
        {
          'a register between session.start and the first prompt': Boolean(reg),
          'it resolves to the watchdog type, no register rejects':
            String(reg?.result ?? '').includes('watchdog:') && errors.length === 0,
          'a spawn of the type gets an agentId': spawned.length > 0,
        },
        [
          `register ${reg ? `+${reg.t - start.t} ms ${clip(reg.result, 120)}` : 'none'}; spawns ${spawned.length}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc6-register-tui',
    title:
      'In the TUI, a register inside the /watchdog on command.run hook resolves, and a later spawn of the ' +
      'type works',
    source: '§16.4 #6',
    kind: 'deterministic',
    scenario: 'tui-review',
    verify: (obs) => {
      const command = ofEvent(
        obs.events,
        'command.run.in',
        (event) => event.command === 'watchdog' && event.args === 'on'
      )[0];
      if (!command) {
        return inconclusive(['/watchdog on did not run', obs.run.logs]);
      }
      const reply = commandOut(obs.events, 'on', command.t);
      const inside = ofEvent(
        obs.events,
        'agent.register',
        (event) => event.t >= command.t && (!reply || event.t <= reply.t)
      );
      const errors = ofEvent(obs.events, 'agent.register.error');
      const spawned = watchdogSpawns(obs.events).filter((spawn) => spawn.agentId && spawn.t > command.t);
      return expectAll(
        {
          'a register inside the /watchdog on hook resolves': inside.some((event) =>
            String(event.result ?? '').includes('watchdog:')
          ),
          'no register rejects': errors.length === 0,
          'a later spawn of the type gets an agentId': spawned.length > 0,
        },
        [
          `registers in the hook ${inside.length}, all ${ofEvent(obs.events, 'agent.register').length}; ` +
            `spawns ${spawned.length}, in a turn with a register ${sameTurnSpawns(obs.events).length}`,
          clip(oneLine(reply?.text), 160),
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc6-same-handler',
    title: 'A register and a spawn of that type in the same hook handler: the spawn works',
    source: '§16.4 #6',
    kind: 'deterministic',
    scenario: 'fc3-fork-tui',
    verify: (obs) => {
      const call = obs.log.find((event) => event.ev === 'spawn.call');
      if (!call) {
        return fail(['the WDGO prompt.submit hook did not run', obs.run.logs]);
      }
      const resolved = obs.log.find((event) => event.ev === 'spawn.resolved');
      const rejected = obs.log.find((event) => event.ev === 'spawn.rejected');
      return expectAll(
        {
          'the register in the handler resolves': call.registered?.ok === true,
          'the spawn in the same handler resolves with an agentId': Boolean(resolved?.agentId) && !rejected,
        },
        [clip(call.registered, 120), clip(resolved ?? rejected, 160), obs.run.logs]
      );
    },
  },
  {
    id: 'fc6-first-event-tui',
    title:
      'The first TUI lifecycle event is command.describe, before session.start; a register there resolves; ' +
      'no $ at load',
    source: '§16.4 #6',
    kind: 'advisory',
    scenario: 'fc3-fork-tui',
    verify: (obs) => {
      const facts = loadFacts(obs.log);
      return expectAll(
        {
          'command.describe comes before session.start': facts.first === 'command.describe',
          'a register at that event resolves': facts.call?.event === facts.first && Boolean(facts.ok) && !facts.error,
          'no $ at load': facts.hasNoDollar,
        },
        [...facts.lines, clip(facts.ok ?? facts.error ?? 'no first register', 160), obs.run.logs]
      );
    },
  },
  {
    id: 'fc6-first-event-p',
    title: 'In -p the first lifecycle event is session.start, and a register there resolves',
    source: '§16.4 #6',
    kind: 'advisory',
    scenario: 'fc3-fork-p',
    verify: (obs) => {
      const facts = loadFacts(obs.log);
      return expectAll(
        {
          'session.start is the first lifecycle event': facts.first === 'session.start',
          'a register there resolves': Boolean(facts.ok) && !facts.error,
          'no $ at load': facts.hasNoDollar,
        },
        [...facts.lines, clip(facts.ok ?? facts.error ?? 'no first register', 160), obs.run.logs]
      );
    },
  },
  scopeCheck({ tool: 'Read', surface: 'p', mode: 'default' }),
  scopeCheck({ tool: 'Grep', surface: 'p', mode: 'default' }),
  scopeCheck({ tool: 'Glob', surface: 'p', mode: 'default' }),
  scopeCheck({ tool: 'Read', surface: 'tui', mode: 'default' }),
  scopeCheck({ tool: 'Grep', surface: 'tui', mode: 'default' }),
  scopeCheck({ tool: 'Glob', surface: 'tui', mode: 'default' }),
  scopeCheck({ tool: 'Read', surface: 'p', mode: 'plan' }),
  scopeCheck({ tool: 'Grep', surface: 'p', mode: 'plan' }),
  scopeCheck({ tool: 'Glob', surface: 'p', mode: 'plan' }),
  scopeCheck({ tool: 'Read', surface: 'tui', mode: 'plan' }),
  scopeCheck({ tool: 'Grep', surface: 'tui', mode: 'plan' }),
  scopeCheck({ tool: 'Glob', surface: 'tui', mode: 'plan' }),
  {
    id: 'fc7-main-dialog',
    title: 'In the TUI a main-loop Read outside the cwd is an engine ask that opens a permission dialog',
    source: '§16.4 #7',
    kind: 'deterministic',
    scenario: 'fc7-outside-tui',
    verify: (obs) => {
      const engine = obs.scope.filter(
        (event) => event.ev === 'engine' && !event.agentId && String(event.input).includes(MAIN_OUTSIDE)
      );
      if (engine.length === 0) {
        return inconclusive([`the main loop never read ${MAIN_OUTSIDE}`, obs.run.logs]);
      }
      const other = obs.dialogs.filter((dialog) => !WATCHDOG_DIALOG.test(dialog.text));
      return expectAll(
        {
          'the engine verdict is ask': engine.every((event) => event.decision === 'ask'),
          'a permission dialog opened': other.length > 0,
        },
        [
          `engine ${engine.map((event) => event.decision).join(',')}; dialogs ${obs.dialogs.length}`,
          clip(plain(other[0]?.text).trim().split('\n').slice(-12).join(' | '), 240),
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc8-rows',
    title:
      'One response gives one session.append row for each content block, every row of step N inside the ' +
      'turn.step N window',
    source: '§16.4 #8',
    kind: 'deterministic',
    scenario: 'headless-review',
    verify: (obs) => {
      const windows = responseWindows(obs.events);
      const rows = windows.flatMap((window) => window.rows);
      if (!rows.some((row) => (row.blocks ?? []).some((block) => String(block).startsWith('tool_use:')))) {
        return inconclusive(['the main loop sent no tool_use row', obs.run.logs]);
      }
      const results = new Set(blockIds(obs.events, /^tool_result:(.+)$/u));
      const unpaired = blockIds(obs.events, /^tool_use:[^:]+:(.+)$/u).filter((id) => !results.has(id));
      return expectAll(
        {
          'one block per response row': rows.every((row) => (row.blocks ?? []).length === 1),
          'every response row is inside a turn.step window': windows.every((window) => window.index !== null),
          'each tool_use id has a tool_result row': unpaired.length === 0,
        },
        [
          windows
            .filter((window) => window.rows.length > 0)
            .map((window) => `step ${window.index}: ${window.rows.map((row) => row.blocks.join('+')).join(' | ')}`)
            .join('; '),
          obs.run.logs,
        ].map((line) => clip(line, 280))
      );
    },
  },
  {
    id: 'fc8-fields',
    title:
      'No field links the rows of one response: a row has message, door, origin, uuid; its message has ' +
      'type, role, content',
    source: '§16.4 #8',
    kind: 'advisory',
    scenario: 'fc7-outside-p',
    verify: (obs) => {
      const rows = obs.scope.filter((event) => event.ev === 'row');
      if (rows.length === 0) {
        return inconclusive(['no main response row in the mod log', obs.run.logs]);
      }
      const keys = [...new Set(rows.flatMap((row) => row.keys))];
      const messageKeys = [...new Set(rows.flatMap((row) => row.messageKeys))];
      return expectAll(
        {
          'one block per row': rows.every((row) => row.blocks.length === 1),
          'row keys are message, door, origin, uuid': keys.every((key) => ROW_KEYS.includes(key)),
          'message keys are type, role, content': messageKeys.every((key) => MESSAGE_KEYS.includes(key)),
        },
        [`rows ${rows.length}; keys ${keys.join(',')}; message keys ${messageKeys.join(',')}`, obs.run.logs]
      );
    },
  },
  {
    id: 'fc8-thinking-on',
    title: 'With --thinking-display summarized a -p thinking block carries text',
    source: '§16.4 #8',
    kind: 'advisory',
    scenario: 'fc7-outside-p',
    verify: (obs) => {
      const lengths = thinkingLengths(obs.events);
      if (lengths.length === 0) {
        return inconclusive(['the main loop made no thinking block', obs.run.logs]);
      }
      return lengths.some((length) => length > 0)
        ? pass([`thinking text lengths ${lengths.join(', ')}`, obs.run.logs])
        : fail([`summaries on, but every thinking block is empty: ${lengths.join(', ')}`, obs.run.logs]);
    },
  },
  {
    id: 'fc8-thinking-off',
    title: 'Without showThinkingSummaries a TUI thinking block carries no text',
    source: '§16.4 #8',
    kind: 'advisory',
    scenario: 'fc7-outside-tui',
    verify: (obs) => {
      const lengths = thinkingLengths(obs.events);
      if (lengths.length === 0) {
        return inconclusive(['the main loop made no thinking block', obs.run.logs]);
      }
      return lengths.every((length) => length === 0)
        ? pass([`${lengths.length} thinking blocks, all empty`, obs.run.logs])
        : fail([`summaries off, but thinking text lengths ${lengths.join(', ')}`, obs.run.logs]);
    },
  },
  {
    id: 'fc9-billing',
    title:
      'A 400 billing_error with the credit message ends the watchdog with the row Credit balance is too ' +
      'low, no usage, one request, and one halt',
    source: '§16.4 #9',
    kind: 'deterministic',
    scenario: 'fc9-billing',
    verify: (obs) => {
      const ends = agentTurnCompletes(obs.events).filter((event) => event.reason === 'error');
      if (ends.length === 0) {
        return agentTurnCompletes(obs.events).length === 0 && watchdogSpawns(obs.events).length === 0
          ? inconclusive(['no watchdog review spawned', obs.run.logs])
          : fail(['no watchdog turn ended with reason error', obs.run.logs]);
      }
      const end = ends[0];
      const row = ofEvent(
        obs.events,
        'session.append',
        (event) => event.agentId === end.agentId && event.origin?.model === '<synthetic>'
      ).find((event) => String(event.text).includes(BILLING_ROW));
      const halts = ofEvent(obs.events, 'ui.log', (event) => String(event.text).includes(`halted: ${BILLING_ROW}`));
      const injected = obs.proxy.filter((line) => line.who === 'agent' && line.injected);
      const usage = end.usage;
      const hasNoUsage = usage == null || (typeof usage === 'object' && !usage.input_tokens && !usage.output_tokens);
      return expectAll(
        {
          'the synthetic row text is exactly Credit balance is too low': row?.text === BILLING_ROW,
          'turn.complete has reason error and an empty answer': end.reason === 'error' && (end.answer ?? '') === '',
          'turn.complete has no usage': hasNoUsage,
          'one request, no retry, one halt row': injected.length === 1 && halts.length === 1,
        },
        [
          `row ${clip(row?.text, 80)} answer=${clip(end.answer, 40)} usage=${clip(usage, 80)}`,
          `halt rows ${halts.length}, injected agent requests ${injected.length}: ${clip(halts[0]?.text, 160)}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc9-tui',
    title: 'The TUI draws Credit balance too low for a billing_error on the main loop',
    source: '§16.4 #9',
    kind: 'advisory',
    scenario: 'fc9-billing-tui',
    verify: (obs) =>
      obs.drawn
        ? pass([clip(obs.screen.split('\n').find((line) => line.includes(BILLING_TUI)) ?? '', 200), obs.run.logs])
        : fail([
            `the screen does not show ${BILLING_TUI}`,
            clip(obs.screen.trim().split('\n').slice(-10).join(' | '), 240),
            obs.run.logs,
          ]),
  },
  {
    id: 'fc10-command',
    title:
      'claude -p "/watchdog on <prompt>" runs the command with the whole text as args and the model never ' +
      'sees the prompt; the plugin stays off',
    source: '§16.4 #10',
    kind: 'deterministic',
    scenario: 'fc10-pon',
    verify: (obs) => {
      const command = ofEvent(obs.events, 'command.run.in', (event) => event.command === 'watchdog')[0];
      if (!command) {
        return fail(['the /watchdog command did not run', clip(obs.p.result, 200), obs.run.logs]);
      }
      const reply = ofEvent(obs.events, 'command.run.out', (event) => event.command === 'watchdog')[0];
      const turns = ofEvent(obs.events, 'turn.start', (event) => !event.agentId);
      const numTurns = obs.p.result?.num_turns;
      const regs = ofEvent(obs.events, 'agent.register');
      return expectAll(
        {
          'the command gets on and the prompt as args':
            String(command.args).startsWith('on ') && String(command.args).includes('math.js'),
          'the model never sees the prompt: num_turns 0, no main turn': numTurns === 0 && turns.length === 0,
          'the plugin replies with the usage and registers no agent (no command route, §5.3)':
            reply?.text === USAGE_REPLY && regs.length === 0,
        },
        [
          `args ${clip(command.args, 80)}; num_turns=${numTurns}; main turns ${turns.length}; registers ${regs.length}`,
          `reply ${clip(reply?.text, 120)}; result ${clip(oneLine(obs.p.result?.result), 120)}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc11-reload',
    title:
      'An outside userConfig edit of ~/.claude/settings.json reloads the plugin (row options changed — ' +
      'reloaded) and the watchdog stays on',
    source: '§16.4 #11',
    kind: 'deterministic',
    scenario: 'fc11-reload',
    verify: (obs) => {
      if (!obs.on) {
        return fail(['/watchdog on did not answer', obs.run.logs]);
      }
      const row = obs.screen.split('\n').find((line) => /watchdog: options changed/u.test(line));
      const instances = [...new Set(obs.events.map((event) => event.i))];
      return expectAll(
        {
          'the watchdog reload row is on screen': Boolean(row) && /reloaded/u.test(row),
          'the mod reload row is on screen': /fcreload: options changed/u.test(obs.screen),
          '/watchdog status after the reload says watchdog on ($.state on flag)': /^watchdog on\b/u.test(
            String(obs.status?.text ?? '')
          ),
        },
        [
          clip(row ?? 'no reload row', 200),
          clip(oneLine(obs.status?.text ?? 'no status reply'), 160),
          `immuneTurns set to ${obs.immuneTurns}; observer instances ${instances.length}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'fc11-state',
    title:
      'Across a userConfig reload $.state and $.store survive; module variables, $.clock.after and ' +
      '$.clock.every timers do not; a new timer fires',
    source: '§16.4 #11',
    kind: 'deterministic',
    scenario: 'fc11-reload',
    verify: (obs) => {
      const armed = obs.log.find((event) => event.ev === 'armed');
      if (!armed) {
        return fail(['/fcreload arm did not run', obs.run.logs]);
      }
      const fresh = obs.log.find((event) => event.ev === 'start' && event.inst !== armed.inst && event.t > armed.t);
      if (!fresh) {
        return fail(['no new module instance after the edit', obs.run.logs]);
      }
      if (fresh.t >= armed.t + armed.afterMs) {
        return inconclusive([
          `the reload came ${fresh.t - armed.t} ms after the arm, past the after timer`,
          obs.run.logs,
        ]);
      }
      const old = obs.log.filter((event) => event.inst === armed.inst);
      const ticks = old.filter((event) => event.ev === 'every.tick');
      const late = ticks.filter((event) => event.t > fresh.t + 1000);
      return expectAll(
        {
          'the new instance gets the new options': fresh.options?.mark === 2,
          '$.state survives': fresh.state?.value?.inst === armed.inst,
          '$.store survives': fresh.store?.value?.inst === armed.inst,
          'module variables reset': fresh.counter === 0 && armed.counter === 7,
          'the old $.clock.after timer never fires': !old.some((event) => event.ev === 'after.fire'),
          'the old $.clock.every timer stops': ticks.length > 0 && late.length === 0,
          'a timer of the new instance fires': obs.log.some(
            (event) => event.ev === 'control.fire' && event.inst === fresh.inst
          ),
        },
        [
          `reload +${fresh.t - armed.t} ms after the arm; options ${clip(fresh.options, 60)} counter ${fresh.counter}`,
          `state ${clip(fresh.state, 100)} store ${clip(fresh.store, 100)}`,
          `old ticks ${ticks.length} (after the reload ${late.length}); ` +
            `after timer fired ${old.some((event) => event.ev === 'after.fire')}`,
          obs.run.logs,
        ]
      );
    },
  },
];
