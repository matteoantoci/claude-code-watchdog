// §16.5 release probes, runtime group: review stop and spawn caps, spawn sites, the read-scope ceiling an org sets,
// roster and tools (unknown keys, Agent denies, the parent permission mode, Edit beside Write, tool lists), and the
// namespace of a mod's `$.command` name. The Desktop part of "review stop and spawn caps" is in manual.mjs.
// The probe mods are mods/rr-*; each writes one JSON result into the run's logs folder.
import fs from 'node:fs';
import path from 'node:path';
import { SETTING_SOURCES_WITH_USER, managedTier, sleep } from '../lib/env.mjs';
import { pluginDirs, runHeadless } from '../lib/headless.mjs';
import { ofEvent, readObs, waitObs } from '../lib/observe.mjs';
import { startProxy } from '../lib/proxy-ctl.mjs';
import { createRun, readText } from '../lib/run.mjs';
import { startTui } from '../lib/tui.mjs';
import { readUserSettings, userPluginsOff, withUserSettings, writeUserSettings } from '../lib/user-settings.mjs';
import { clip, expectAll, fail, inconclusive, pass } from '../lib/verdict.mjs';

// The proxy's agentMark for rr-stop's `holder` and rr-peer's `peer`: their requests get a 529 with retry-after 20 s.
const HOLD_MARK = 'RRSTOP-HELD-AGENT';
// rr-stop's TaskStop on an id no task has (mods/rr-stop/hooks/stop.mjs).
const UNKNOWN_ID = 'a0123456789abcdef';
const MAX_HOLDERS = 25;
const BANNED_TOOLS = ['Bash', 'Edit', 'Write'];
const CEILINGS = new Set(['allow', 'ask', 'deny']);

// plugins/watchdog/hooks/failure/classify.ts:28-35 (§12.2): the reject of a whole `Agent` deny, the deny of a scoped
// `Agent(<plugin>:<name>)` rule (the plugin matches its own `watchdog:` prefix), and the two cap texts.
const NO_AGENT_TOOL = '$.tool.call: no tool named "Agent" in this session';
const isScopedDeny = (text, type) =>
  text.startsWith(`Agent type '${type}'`) && text.includes('has been denied by permission rule');
const isCapText = (text) =>
  (text.includes('$.agent.spawn refused:') && text.includes('spawns are running at once')) ||
  text.startsWith('Concurrent subagent limit reached.');
const capCount = (text) => Number(/refused: (\d+) spawns are running at once/u.exec(text)?.[1] ?? Number.NaN);

const flat = (value) => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

const reply = (word) => `Reply with the single word ${word}. Do not use tools.`;

const readProbe = (run, name) => {
  try {
    return JSON.parse(readText(path.join(run.logs, name)));
  } catch {
    return null;
  }
};

// Polls a mod's JSON result until `test(probe)` holds.
const probeWait = (run, name, test, timeoutMs) =>
  waitObs(
    run,
    () => {
      const probe = readProbe(run, name);
      return probe && test(probe) ? probe : null;
    },
    { timeoutMs }
  );

const agentEnd = (events, agentId) => ofEvent(events, 'turn.complete', (event) => event.agentId === agentId)[0];

const waitAgentEnd = (run, agentId, timeoutMs) => waitObs(run, (events) => agentEnd(events, agentId), { timeoutMs });

// The observer and the probe mods, without the real plugin: these facts are the engine's.
const engineMods = (run, mods, fill = {}) => pluginDirs(run, { watchdog: false, mods, fill });

// The text a spawn left: a reject's message or a resolved `{ deny }`.
const spawnText = (spawned) => String(spawned?.rejected?.message ?? spawned?.resolved?.deny ?? '');

const spawnShape = (spawned) => {
  if (!spawned) {
    return 'absent';
  }
  if (spawned.rejected) {
    return 'reject';
  }
  return spawned.resolved?.deny === undefined ? 'resolved' : 'deny';
};

// plugins/watchdog/hooks/stop/install.ts:67-72 (§7.8): the text of a TaskStop that stopped nothing (a reject, a deny
// or an isError result), which the plugin writes once to the dump; undefined for a stop that worked.
const stopProblem = (entry) => {
  if (entry.rejected) {
    return entry.rejected.message;
  }
  if (entry.resolved?.deny !== undefined) {
    return entry.resolved.deny;
  }
  return entry.resolved?.isError === true ? String(entry.resolved.text ?? flat(entry.resolved.result)) : undefined;
};

const stopShape = (entry) => {
  if (entry.rejected) {
    return 'reject';
  }
  if (entry.resolved?.deny !== undefined) {
    return 'deny';
  }
  return entry.resolved?.isError === true ? 'isError' : 'resolved';
};

// Every text a TaskStop left, joined: a success has its message in `result.message` and again in `text` (the result as
// JSON); an isError has it in `text` and `result` (prototypes' TaskStop logs).
const stopText = (entry) =>
  [entry.rejected?.message, entry.resolved?.deny, entry.resolved?.text, entry.resolved && flat(entry.resolved.result)]
    .filter((part, index, parts) => typeof part === 'string' && part !== '' && parts.indexOf(part) === index)
    .join(' | ');

// A forced step that left no result. Each rr-* step is forced by a mod, so a missing one is a failure.
const missingStep = (obs, key, file) => {
  if (!obs.probe) {
    return fail([`no ${file}`, clip(obs.p?.stderr ?? '', 180), `exit ${obs.p?.exitCode ?? 'n/a'}`, obs.run.logs]);
  }
  if (obs.probe.pending === key) {
    return fail([`${key} never settled: the hook ran out of its budget inside it`, obs.run.logs]);
  }
  if (obs.probe.error || obs.probe.registerError) {
    return fail([`hook error: ${clip((obs.probe.error ?? obs.probe.registerError).message, 220)}`, obs.run.logs]);
  }
  return fail([`no ${key} (phase ${obs.probe.phase})`, clip(flat(obs.probe), 240), obs.run.logs]);
};

// --- review stop and spawn caps: headless ----------------------------------------------------------------------

// The proxy's view of holder 1, whose request bodies carry "HELD1.": the times its requests got the 529, and how
// many went upstream.
const holderOne = (proxy) => {
  const ids = new Set(
    proxy
      .bodies()
      .filter(({ body }) => /Reply with exactly HELD1\./u.test(flat(body.messages ?? [])))
      .map(({ id }) => id)
  );
  const log = proxy.log().filter((entry) => ids.has(entry.id));
  return {
    requests: ids.size,
    injectedAt: log.filter((entry) => entry.injected === 529).map((entry) => Date.parse(entry.time)),
    forwarded: log.filter((entry) => entry.forwarded).length,
  };
};

// §16.5 review stop and spawn caps (spec §7.8, §12.2). The default caps (no CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).
// Three prompts; mods/rr-stop acts at each one's main turn.complete. The proxy holds every `holder` agent on a 529
// (retry-after 20 s), so it waits on the model until a stop; `ender` runs on the real model and ends by itself.
const stopHeadless = {
  id: 'rr-stop',
  title: 'TaskStop on an unknown id, on a held agent (twice), after a stop and after a normal end; the default cap',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'rr-stop');
    const proxy = await startProxy(run, { agent: 529, retryAfter: '20', agentMark: HOLD_MARK, saveBodies: true });
    try {
      const p = await runHeadless(run, {
        label: 'p',
        plugins: engineMods(run, ['rr-stop'], { __MODE__: 'headless', __HOLD__: HOLD_MARK }),
        env: proxy.env,
        closeAfterMs: 3000,
        timeoutMs: 240_000,
        input: async (send) => {
          const phaseIn = (phases, timeoutMs) =>
            probeWait(run, 'rr-stop.json', (probe) => phases.includes(probe.phase), timeoutMs);
          send(reply('RRSTOP1'));
          const one = await phaseIn(['stopped', 'error'], 90_000);
          if (one.value?.phase === 'stopped') {
            if (one.value.holders?.[0]) {
              await waitAgentEnd(run, one.value.holders[0], 30_000);
            }
            await sleep(1000);
            send(reply('RRSTOP2'));
            const two = await phaseIn(['ender', 'done', 'error'], 60_000);
            if (two.value?.phase === 'ender') {
              await waitAgentEnd(run, two.value.ender.agentId, 60_000);
              await sleep(1000);
              send(reply('RRSTOP3'));
              await phaseIn(['done', 'error'], 30_000);
            }
          }
          // A holder that a broken phase left running ends at its next retry instead of holding -p open.
          proxy.setMode({ agentMark: HOLD_MARK, saveBodies: true });
        },
      });
      await sleep(1000);
      return {
        run,
        p,
        events: readObs(run),
        probe: readProbe(run, 'rr-stop.json'),
        holder: holderOne(proxy),
      };
    } finally {
      proxy.stop();
    }
  },
};

// --- review stop and spawn caps: TUI ---------------------------------------------------------------------------

// §16.5 the caps and maxTurns in the TUI. CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=1. RRHOLD: rr-stop holds the one
// slot (proxy 529) and its second spawn meets the per-plugin cap. RRPEER: rr-peer (a second plugin, count 0) meets
// the session cap, then rr-stop stops its holder. RRCAP: a maxTurns 2 agent takes the freed slot.
const stopTui = {
  id: 'rr-stop-tui',
  title: 'The per-plugin cap, the session cap, a freed slot and maxTurns in the TUI',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rr-stop-tui');
    const proxy = await startProxy(run, { agent: 529, retryAfter: '20', agentMark: HOLD_MARK });
    let tui = null;
    try {
      tui = await startTui(run, {
        label: 'tui',
        plugins: engineMods(run, ['rr-stop', 'rr-peer'], { __MODE__: 'tui', __HOLD__: HOLD_MARK }),
        env: { ...proxy.env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '1' },
      });
      const phaseIn = (phases, timeoutMs) =>
        probeWait(run, 'rr-stop.json', (probe) => phases.includes(probe.phase), timeoutMs);
      await tui.type(reply('RRHOLD'));
      const held = await phaseIn(['held', 'error'], 90_000);
      if (held.value?.phase === 'held') {
        await tui.waitIdle({ timeoutMs: 30_000 });
        await tui.type(reply('RRPEER'));
        const stopped = await phaseIn(['stopped', 'error'], 60_000);
        if (stopped.value?.phase === 'stopped') {
          if (stopped.value.holders?.[0]) {
            await waitAgentEnd(run, stopped.value.holders[0], 30_000);
          }
          await tui.waitIdle({ timeoutMs: 30_000 });
          await sleep(1000);
          await tui.type(reply('RRCAP'));
          const capped = await phaseIn(['done', 'error'], 60_000);
          if (capped.value?.capper?.agentId) {
            await waitAgentEnd(run, capped.value.capper.agentId, 120_000);
          }
        }
      }
      await tui.waitIdle({ timeoutMs: 30_000 });
      const screen = tui.capture('after');
      return {
        run,
        events: readObs(run),
        probe: readProbe(run, 'rr-stop.json'),
        peer: readProbe(run, 'rr-peer.json'),
        screen,
      };
    } finally {
      await tui?.stop();
      proxy.stop();
    }
  },
};

// --- spawn sites ------------------------------------------------------------------------------------------------

// §16.5 spawn sites (spec §7.2, §10.3). One -p session kept open by stream-json input: a Read turn (step and tool
// sites, the busy clock), then the busy clock's CLOCKED turn if it starts, then the idle clock's IDLED turn.
const spawnSites = {
  id: 'rr-spawn',
  title: 'Spawns at turn.step index >= 1, in a tool.call hook, and from $.clock.after during a turn and in idle -p',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'rr-spawn');
    const p = await runHeadless(run, {
      label: 'p',
      plugins: engineMods(run, ['rr-spawn']),
      // The step and tool sites need one Read round: an allowed tool and a prompt that names it.
      args: ['--allowedTools', 'Read'],
      closeAfterMs: 4000,
      timeoutMs: 240_000,
      input: async (send) => {
        send('First call the Read tool on a.txt. After its result, reply with the first word of that file.');
        const idle = await probeWait(run, 'rr-spawn.json', (probe) => probe.sites?.idle, 150_000);
        const site = idle.value?.sites?.idle;
        // The IDLED turn, when the idle submit resolved, and the idle agent's end.
        await waitObs(
          run,
          (events) => {
            const isIdled = (event) => !event.agentId && /IDLED/u.test(event.text ?? '');
            const start = ofEvent(events, 'turn.start', isIdled)[0];
            const isTurnDone = site?.submit?.resolved
              ? Boolean(start && ofEvent(events, 'turn.complete', (event) => event.turnId === start.turnId)[0])
              : true;
            return isTurnDone && (!site?.agentId || agentEnd(events, site.agentId)) ? true : null;
          },
          { timeoutMs: 45_000 }
        );
      },
    });
    await sleep(1000);
    return { run, p, events: readObs(run), probe: readProbe(run, 'rr-spawn.json') };
  },
};

// What reached rr-spawn of one agent: on('*') (another registration), its own turn.step, tool.call and
// turn.complete registrations, and the observer (another plugin) as the reference for the agent's tool calls.
const siteFacts = (obs, agentId) => {
  const witness = obs.probe.witness?.[agentId] ?? {};
  return {
    witnessSteps: witness['turn.step'] ?? 0,
    witnessTools: witness['tool.call'] ?? 0,
    witnessRows: witness['session.append'] ?? 0,
    stepHook: obs.probe.stepHook?.[agentId]?.count ?? 0,
    toolHook: obs.probe.toolHook?.[agentId]?.count ?? 0,
    complete: obs.probe.completeHook?.[agentId]?.count ?? 0,
    agentTools: ofEvent(obs.events, 'tool.call.in', (event) => event.agentId === agentId).length,
    agentSteps: ofEvent(obs.events, 'turn.step', (event) => event.agentId === agentId).length,
    end: agentEnd(obs.events, agentId),
  };
};

const factLine = (tag, agentId, facts) =>
  `${tag} ${agentId}: observer steps=${facts.agentSteps} tools=${facts.agentTools}; ` +
  `on('*') steps=${facts.witnessSteps} tools=${facts.witnessTools} rows=${facts.witnessRows}; ` +
  `on('turn.step')=${facts.stepHook} on('tool.call')=${facts.toolHook} on('turn.complete')=${facts.complete}; ` +
  `end ${facts.end?.reason ?? 'none'}`;

// A clock site's spawn: what reached the module of its agent, or why it did not spawn.
const siteLine = (obs, tag, site) =>
  site.agentId
    ? `spawn resolved: ${factLine(tag, site.agentId, siteFacts(obs, site.agentId))}`
    : `spawn: ${clip(spawnText(site), 180)}`;

const submitLine = (site) =>
  site.submit?.rejected
    ? `submit rejected: ${clip(site.submit.rejected.message, 160)}`
    : `submit resolved: ${clip(flat(site.submit?.resolved), 160)}`;

// The main turn a clock submit started (its text frame names the plugin), and when, after the first main turn.
const submittedTurn = (obs, word) => {
  const first = ofEvent(obs.events, 'turn.complete', (event) => !event.agentId)[0];
  const start = ofEvent(obs.events, 'turn.start', (event) => !event.agentId && (event.text ?? '').includes(word))[0];
  if (!start) {
    return `${word} turn: never started`;
  }
  const done = ofEvent(obs.events, 'turn.complete', (event) => event.turnId === start.turnId)[0];
  const after = first ? `${start.t - first.t} ms after the first main turn ended` : 'no first main turn.complete';
  return `${word} turn: started ${after}; ${done ? `ended (${done.reason})` : 'did not end'}; ${clip(start.text, 90)}`;
};

// --- roster and tools: Agent denies -----------------------------------------------------------------------------

// One `-p` session of mods/rr-deny; `types` are the agent names it spawns at the first main turn.complete.
const denyRun = async (run, { types, args = [], settingSources }) => {
  const p = await runHeadless(run, {
    label: 'p',
    plugins: engineMods(run, ['rr-deny'], { __TYPES__: types.join(',') }),
    args,
    settingSources,
    prompt: reply('OK'),
    timeoutMs: 120_000,
  });
  return { run, p, probe: readProbe(run, 'rr-deny.json') };
};

// The SDK parent tier of managed settings: the policy source when no admin managed tier is installed.
const managedArgs = (deny) => ['--managed-settings', JSON.stringify({ permissions: { deny } })];

const projectDeny = (deny) => ({ '.claude/settings.json': { permissions: { deny } } });

// §16.5 a deny in --disallowedTools or managed settings, and the legacy Task names, against the project-settings
// baseline (research/smoke-agent-deny.md). Four short -p sessions at once: a whole-tool deny removes the tool, so
// each whole deny needs its own session; one session holds every scoped rule.
const denyTools = {
  id: 'rr-deny',
  title: 'Agent denies from --disallowedTools, managed and project settings, with Agent and Task names',
  needs: [],
  run: async (ctx) => {
    const runs = ['cli-agent', 'cli-task', 'managed-agent'].map((name) => createRun(ctx, `rr-deny-${name}`));
    const scopedRun = createRun(ctx, 'rr-deny-scoped', {
      files: projectDeny(['Agent(rrdeny:kp)', 'Task(rrdeny:kpt)']),
    });
    const [cliAgent, cliTask, managed, scoped] = await Promise.all([
      denyRun(runs[0], { types: ['keeper'], args: ['--disallowedTools', 'Agent'] }),
      denyRun(runs[1], { types: ['keeper'], args: ['--disallowedTools', 'Task'] }),
      denyRun(runs[2], { types: ['keeper'], args: managedArgs(['Agent']) }),
      denyRun(scopedRun, {
        types: ['kp', 'kpt', 'kc', 'kct', 'km', 'kmt', 'ok'],
        args: [
          '--disallowedTools',
          'Agent(rrdeny:kc)',
          'Task(rrdeny:kct)',
          ...managedArgs(['Agent(rrdeny:km)', 'Task(rrdeny:kmt)']),
        ],
      }),
    ]);
    return { cliAgent, cliTask, managed, scoped };
  },
};

// §16.5 a deny in user settings. Writes ~/.claude/settings.json (backed up and restored byte for byte); the
// person's plugins are off in each session's settings.local.json.
const denyUser = {
  id: 'rr-deny-user',
  title: 'Agent denies from user settings, with Agent and Task names',
  needs: ['user-settings'],
  run: async (ctx) => {
    const off = { '.claude/settings.local.json': { enabledPlugins: userPluginsOff() } };
    const wholeRun = createRun(ctx, 'rr-deny-user-agent', { files: off });
    const scopedRun = createRun(ctx, 'rr-deny-user-scoped', { files: off });
    return withUserSettings(wholeRun, async () => {
      const original = readUserSettings();
      const withDeny = (deny) =>
        writeUserSettings({
          ...original,
          permissions: { ...original.permissions, deny: [...(original.permissions?.deny ?? []), ...deny] },
        });
      withDeny(['Agent']);
      const whole = await denyRun(wholeRun, { types: ['keeper'], settingSources: SETTING_SOURCES_WITH_USER });
      withDeny(['Agent(rrdeny:ku)', 'Task(rrdeny:kut)']);
      const scoped = await denyRun(scopedRun, {
        types: ['ku', 'kut', 'ok'],
        settingSources: SETTING_SOURCES_WITH_USER,
      });
      return { whole, scoped };
    });
  },
};

const spawnOf = (session, name) => session?.probe?.spawns?.[name];

// §12.2 blocked: the whole-tool reject, with no agent.
const isWholeDeny = (session) => {
  const spawned = spawnOf(session, 'keeper');
  return Boolean(spawned) && !spawned.agentId && spawnText(spawned).includes(NO_AGENT_TOOL);
};

// §12.2 blocked: the scoped deny text for `rrdeny:<name>`, with no agent.
const isScoped = (session, name) => {
  const spawned = spawnOf(session, name);
  return Boolean(spawned) && !spawned.agentId && isScopedDeny(spawnText(spawned), `rrdeny:${name}`);
};

const denyLine = (label, session, name) => {
  const spawned = spawnOf(session, name);
  const tools = session?.probe?.hasAgentTool === undefined ? '' : ` (Agent tool listed: ${session.probe.hasAgentTool})`;
  const agent = spawned?.agentId ? ` ${spawned.agentId}` : '';
  return `${label}: ${spawnShape(spawned)}${agent} ${clip(spawnText(spawned), 170)}${tools}`;
};

const noDenyResult = (sessions) => {
  const lost = sessions.find((session) => !session?.probe);
  return lost
    ? fail([`no rr-deny.json in ${lost?.run?.name}`, clip(lost?.p?.stderr ?? '', 200), `exit ${lost?.p?.exitCode}`])
    : null;
};

// --- roster and tools: permission mode, Edit, tool lists -------------------------------------------------------

// The tool names of the first request of each probe agent whose system prompt carries its mark.
const agentToolLists = (proxy) => {
  const lists = {};
  for (const { body } of proxy.bodies()) {
    const system = flat(body.system ?? '');
    for (const [key, mark] of [
      ['listed', 'RRTOOLS-LISTED'],
      ['denied', 'RRTOOLS-DENIED'],
    ]) {
      if (!lists[key] && system.includes(mark)) {
        lists[key] = (body.tools ?? []).map((tool) => tool.name);
      }
    }
  }
  return lists;
};

// One -p session of mods/rr-perm under a parent permission mode. `tools` adds the tool-list agents and the proxy
// that saves their request bodies.
const permRun = async (ctx, name, { args = [], tools = false }) => {
  const run = createRun(ctx, `rr-perm-${name}`);
  const proxy = tools ? await startProxy(run, { saveBodies: true }) : null;
  try {
    const p = await runHeadless(run, {
      label: 'p',
      plugins: engineMods(run, ['rr-perm'], { __TOOLS__: tools ? 'yes' : 'no' }),
      env: proxy?.env ?? {},
      args,
      prompt: reply('OK'),
      timeoutMs: 180_000,
    });
    await sleep(500);
    return {
      name,
      run,
      p,
      probe: readProbe(run, 'rr-perm.json'),
      edited: readText(path.join(run.proj, 'math.js')).includes('RRPERM'),
      wrote: fs.existsSync(path.join(run.proj, 'rr-wrote.txt')),
      agentTools: proxy ? agentToolLists(proxy) : null,
    };
  } finally {
    proxy?.stop();
  }
};

// §16.5 an auto or bypassPermissions parent acts like acceptEdits; Edit follows the Write path; a tools list without
// Bash, Edit and Write blocks them like disallowedTools. The editor agent declares dontAsk, so with the default parent
// its Edit and Write are refused, and a parent mode that wins lets both run (research/smoke-mutating-tools.md Q3).
// Three short -p sessions at once.
const permParent = {
  id: 'rr-perm',
  title: 'An agent Edit and Write under a default, a bypassPermissions and an auto parent; agent tool lists',
  needs: [],
  run: async (ctx) => {
    const [base, bypass, auto] = await Promise.all([
      permRun(ctx, 'default', { tools: true }),
      permRun(ctx, 'bypass', {
        args: ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'],
      }),
      permRun(ctx, 'auto', { args: ['--permission-mode', 'auto'] }),
    ]);
    return { base, bypass, auto };
  },
};

// The editor's Edit or Write: its tool.call result and its tool.check verdict (none when the mode asks nothing).
const editorCall = (session, tool) => {
  const editor = session.probe?.spawns?.editor?.agentId;
  const call = (session.probe?.calls ?? []).find((item) => item.tool === tool && item.agentId === editor);
  const check = (session.probe?.checks ?? []).find((item) => item.tool === tool && item.agentId === editor);
  return call ? { ...call, decision: check?.decision ?? 'none' } : null;
};

const permLine = (session) => {
  const parts = ['Edit', 'Write'].map((tool) => {
    const call = editorCall(session, tool);
    return call ? `${tool} ${call.isError ? 'refused' : 'ran'} (check ${call.decision})` : `${tool} not called`;
  });
  const mode = session.p?.init?.permissionMode ?? 'no init';
  const files = `math.js edited=${session.edited} rr-wrote.txt=${session.wrote}`;
  return `${session.name} (permissionMode ${mode}): ${parts.join(', ')}; ${files}`;
};

// One parent mode: `wins` when both calls ran and both files changed, `refused` when both were refused, else null.
const permOutcome = (session) => {
  const edit = editorCall(session, 'Edit');
  const write = editorCall(session, 'Write');
  if (!edit || !write) {
    return null;
  }
  if (!edit.isError && !write.isError && session.edited && session.wrote) {
    return 'wins';
  }
  return edit.isError && write.isError ? 'refused' : 'mixed';
};

// --- roster: unknown keys ----------------------------------------------------------------------------------------

const ROSTER = {
  rrUnknown: true,
  watchdogs: [{ name: 'probe', model: 'haiku', effort: 'low', rrEntryUnknown: 1 }],
};

const commandReply = (run, args, after) =>
  waitObs(
    run,
    (events) =>
      ofEvent(
        events,
        'command.run.out',
        (event) => event.command === 'watchdog' && event.args === args && event.t > after
      )[0],
    { timeoutMs: 30_000 }
  );

// §16.5 unknown roster keys (spec §4.6). A project WATCHDOG.json with an unknown top-level key and an unknown entry
// key: /watchdog on, then /watchdog status. No prompt, so no review runs.
const rosterKeys = {
  id: 'rr-roster',
  title: 'A WATCHDOG.json with unknown top-level and entry keys: /watchdog on and /watchdog status',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rr-roster', { files: { 'WATCHDOG.json': ROSTER } });
    const tui = await startTui(run, { label: 'tui' });
    try {
      const t0 = Date.now();
      await tui.type('/watchdog on');
      const on = await commandReply(run, 'on', t0);
      // §13.2: the warning-count row comes 300 ms after the reply (COMMAND_LOG_DELAY_MS).
      const isCountRow = (event) => /WATCHDOG\.json warning/u.test(event.text ?? '');
      await waitObs(run, (events) => ofEvent(events, 'ui.log', isCountRow)[0], { timeoutMs: 10_000 });
      const t1 = Date.now();
      await tui.type('/watchdog status');
      const status = await commandReply(run, 'status', t1);
      await sleep(1500);
      const screen = tui.capture('status');
      return { run, events: readObs(run), on: on.value ?? null, status: status.value ?? null, screen };
    } finally {
      await tui.stop();
    }
  },
};

// --- read scope: an org ceiling ---------------------------------------------------------------------------------

// §16.5 a tool.check ceiling that an org sets (spec §6.5). Opt in with --with org:ceiling. Two prompts, 8 s apart,
// so connector tools that connect late are in the second sweep.
const ceiling = {
  id: 'rr-ceiling',
  title: 'tool.check verdicts of every tool under an org ceiling, and a hook allow on a capped tool',
  needs: ['org:ceiling'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rr-ceiling');
    const p = await runHeadless(run, {
      label: 'p',
      plugins: engineMods(run, ['rr-ceiling']),
      closeAfterMs: 2000,
      timeoutMs: 180_000,
      input: async (send) => {
        send(reply('RRCEIL1'));
        await probeWait(run, 'rr-ceiling.json', (probe) => probe.sweeps?.length >= 1, 90_000);
        await sleep(8000);
        send(reply('RRCEIL2'));
        await probeWait(run, 'rr-ceiling.json', (probe) => probe.sweeps?.length >= 2, 90_000);
      },
    });
    return { run, p, events: readObs(run), probe: readProbe(run, 'rr-ceiling.json') };
  },
};

export const scenarios = [stopHeadless, stopTui, spawnSites, denyTools, denyUser, permParent, rosterKeys, ceiling];

export const checks = [
  // --- review stop and spawn caps (spec §7.8, §12.2) ---
  {
    id: 'rr-stop-unknown',
    title: 'TaskStop on an unknown id gives an error the plugin logs, naming the id',
    source: '§16.5: review stop and spawn caps (TaskStop on an unknown id)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const entry = obs.probe?.unknown;
      if (!entry) {
        return missingStep(obs, 'unknown', 'rr-stop.json');
      }
      const problem = String(stopProblem(entry) ?? '');
      return expectAll(
        {
          'the stop failed (a reject, a deny or an isError result)': stopProblem(entry) !== undefined,
          'the text is No task found with ID: <id>':
            problem.includes('No task found with ID') && problem.includes(UNKNOWN_ID),
        },
        [`${stopShape(entry)}: ${clip(stopText(entry), 220)}`, obs.run.logs]
      );
    },
  },
  {
    id: 'rr-stop-live',
    title: 'TaskStop on a running agent resolves "Successfully stopped task", and no stop starts a main turn',
    source: '§16.5: review stop and spawn caps (TaskStop)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const entry = obs.probe?.stopLive;
      if (!entry) {
        return missingStep(obs, 'stopLive', 'rr-stop.json');
      }
      const first = obs.probe.holders[0];
      const isExtra = (event) => !event.agentId && !/RRSTOP\d/u.test(event.text ?? '');
      const extra = ofEvent(obs.events, 'turn.start', isExtra);
      return expectAll(
        {
          'TaskStop resolves with no deny and no isError': stopShape(entry) === 'resolved',
          'the text is Successfully stopped task: <agentId>': stopText(entry).includes(
            `Successfully stopped task: ${first}`
          ),
          'no stop starts a main turn': extra.length === 0,
        },
        [
          clip(stopText(entry), 200),
          `main turns the probe did not send: ${extra.length} ${clip(extra[0]?.text ?? '', 80)}`,
        ]
      );
    },
  },
  {
    id: 'rr-stop-model-wait',
    title: 'A stop while the agent waits on the model ends it at once: aborted, isAborted, empty answer',
    source: '§16.5: review stop and spawn caps (a stop while the agent waits on the model)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const entry = obs.probe?.stopLive;
      if (!entry) {
        return missingStep(obs, 'stopLive', 'rr-stop.json');
      }
      const first = obs.probe.holders[0];
      const end = agentEnd(obs.events, first);
      const waited = obs.holder.injectedAt.filter((time) => time < obs.probe.stopAt).length;
      const lag = end ? end.t - obs.probe.stopAt : null;
      return expectAll(
        {
          "the agent's request got the proxy's 529 before the stop, none went upstream":
            waited > 0 && obs.holder.forwarded === 0,
          'TaskStop resolves': stopShape(entry) === 'resolved',
          'turn.complete: reason aborted, isAborted, answer ""':
            end?.reason === 'aborted' && end.isAborted === true && end.answer === '',
          'the end comes within 5 s, not after the 20 s retry wait': lag !== null && lag < 5000,
        },
        [
          `holder ${first}: ${obs.holder.requests} requests, ${waited} got a 529 before the stop, ` +
            `${obs.holder.forwarded} forwarded`,
          end
            ? `end ${end.reason} isAborted=${end.isAborted} answer=${JSON.stringify(end.answer)} +${lag} ms`
            : 'no end',
        ]
      );
    },
  },
  {
    id: 'rr-stop-twice',
    title: 'A second TaskStop at once on the same agent settles with a known result',
    source: '§16.5: review stop and spawn caps (TaskStop twice)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const entry = obs.probe?.stopTwice;
      if (!entry) {
        return missingStep(obs, 'stopTwice', 'rr-stop.json');
      }
      const problem = stopProblem(entry);
      const isKnown =
        problem === undefined
          ? /Successfully stopped task:|had already ended/u.test(stopText(entry))
          : /is not running \(status: |No task found with ID:/u.test(problem);
      const lines = [
        `${stopShape(entry)} in ${entry.ms} ms: ${clip(stopText(entry), 220)}`,
        `the plugin ${problem === undefined ? 'logs nothing' : 'logs "TaskStop failed" once to the dump'}`,
      ];
      return isKnown ? pass(lines) : fail(['an unknown result for the second stop', ...lines]);
    },
  },
  {
    id: 'rr-stop-ended',
    title: 'TaskStop on an agent that already ended (after a stop, after a normal end) gives an error the plugin logs',
    source: '§16.5: review stop and spawn caps (TaskStop on an agent that already ended)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const killed = obs.probe?.stopEnded;
      const natural = obs.probe?.stopComplete;
      if (!killed) {
        return missingStep(obs, 'stopEnded', 'rr-stop.json');
      }
      if (!natural) {
        return missingStep(obs, 'stopComplete', 'rr-stop.json');
      }
      return expectAll(
        {
          'after its stop: the stop fails (reject, deny or isError)': stopProblem(killed) !== undefined,
          'after a normal end: the stop fails (reject, deny or isError)': stopProblem(natural) !== undefined,
        },
        [
          `after its stop ($.agent.list ${obs.probe.killedStatus}): ${stopShape(killed)} ` +
            clip(stopText(killed), 170),
          `after a normal end ($.agent.list ${obs.probe.enderStatus}): ${stopShape(natural)} ` +
            clip(stopText(natural), 170),
        ]
      );
    },
  },
  {
    id: 'rr-stop-slot',
    title: 'At the per-plugin cap, the slot of a stopped agent frees for the next spawn',
    source: '§16.5: review stop and spawn caps (whether a slot of the per-plugin cap frees after a stop)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const slot = obs.probe?.slot;
      if (!slot) {
        return missingStep(obs, 'slot', 'rr-stop.json');
      }
      const over = obs.probe.over;
      if (!over || !isCapText(spawnText(over))) {
        return fail([`the cap was never reached, so the slot test means nothing: ${clip(spawnText(over), 160)}`]);
      }
      const lines = [
        `${obs.probe.holders.length - 1} holders still running; the stopped one: ${obs.probe.killedStatus}`,
        slot.agentId ? `the next spawn resolved ${slot.agentId}` : `the next spawn: ${clip(spawnText(slot), 200)}`,
      ];
      return slot.agentId ? pass(lines) : fail(lines);
    },
  },
  {
    id: 'rr-stop-cap',
    title: 'The spawn over the per-plugin cap rejects: "<plugin>: $.agent.spawn refused: N spawns are running at once"',
    source: '§16.5: review stop and spawn caps (the per-plugin cap)',
    kind: 'deterministic',
    scenario: 'rr-stop',
    verify: (obs) => {
      const over = obs.probe?.over;
      if (!over) {
        return obs.probe?.holders?.length === MAX_HOLDERS
          ? fail([`no cap within ${MAX_HOLDERS} spawns`])
          : missingStep(obs, 'over', 'rr-stop.json');
      }
      const text = spawnText(over);
      const seen = ofEvent(obs.events, 'agent.spawn.in', (event) =>
        String(event.prompt ?? '').includes(`HELD${over.running + 1}.`)
      );
      return expectAll(
        {
          'the spawn rejects (no deny)': spawnShape(over) === 'reject',
          'the text is rrstop: $.agent.spawn refused: N spawns are running at once': text.includes(
            'rrstop: $.agent.spawn refused:'
          ),
          'N is the count of running holders': capCount(text) === over.running,
          'the plugin reads it as a cap (backlog, no failure)': isCapText(text),
        },
        [clip(text, 200), `holders running: ${over.running}; agent.spawn events of the refused spawn: ${seen.length}`]
      );
    },
  },
  {
    id: 'rr-stop-cap-default',
    title: 'The default per-plugin cap is 20',
    source: '§16.5: review stop and spawn caps (the default cap of 20)',
    kind: 'advisory',
    scenario: 'rr-stop',
    verify: (obs) => {
      const over = obs.probe?.over;
      if (!over) {
        return inconclusive([`no refused spawn: ${obs.probe?.holders?.length ?? 0} holders`]);
      }
      const count = capCount(spawnText(over));
      const lines = [`refused at spawn ${over.running + 1}: ${clip(spawnText(over), 160)}`];
      return count === 20 ? pass(lines) : fail([`the cap is ${count}, not 20`, ...lines]);
    },
  },
  {
    id: 'rr-stop-tui-cap',
    title: 'In the TUI the per-plugin cap rejects, the session cap refuses another plugin, and a stop frees the slot',
    source: '§16.5: review stop and spawn caps (the caps in the TUI)',
    kind: 'deterministic',
    scenario: 'rr-stop-tui',
    verify: (obs) => {
      if (!obs.probe) {
        return fail(['no rr-stop.json', obs.run.logs]);
      }
      const over = obs.probe.over;
      const peer = obs.peer?.spawn;
      const capper = obs.probe.capper;
      const overText = spawnText(over);
      const peerText = spawnText(peer);
      return expectAll(
        {
          'per-plugin cap: the second spawn rejects with "refused: 1 spawns are running at once"':
            spawnShape(over) === 'reject' && capCount(overText) === 1 && isCapText(overText),
          'session cap: the other plugin is refused with "Concurrent subagent limit reached."':
            !peer?.agentId && peerText.startsWith('Concurrent subagent limit reached.') && isCapText(peerText),
          'the stop resolves': obs.probe.stopLive !== undefined && stopShape(obs.probe.stopLive) === 'resolved',
          'after the stop, the next spawn takes the freed slot': Boolean(capper?.agentId),
        },
        [
          `per-plugin (${spawnShape(over)}): ${clip(overText, 140)}`,
          `session (${spawnShape(peer)}): ${clip(peerText, 160)}`,
          `capper: ${capper?.agentId ?? clip(spawnText(capper), 140)}`,
          obs.run.logs,
        ]
      );
    },
  },
  {
    id: 'rr-stop-tui-maxturns',
    title: 'In the TUI, maxTurns 2 ends the agent after 2 steps with reason answer and an empty answer',
    source: '§16.5: review stop and spawn caps (maxTurns in the TUI)',
    kind: 'deterministic',
    scenario: 'rr-stop-tui',
    verify: (obs) => {
      const agentId = obs.probe?.capper?.agentId;
      if (!agentId) {
        const why = clip(spawnText(obs.probe?.capper), 160);
        return inconclusive([`the capper did not spawn (see rr-stop-tui-cap): ${why}`]);
      }
      const end = agentEnd(obs.events, agentId);
      if (!end) {
        return fail([`capper ${agentId} did not end within 120 s`, obs.run.logs]);
      }
      const steps = ofEvent(obs.events, 'turn.step', (event) => event.agentId === agentId);
      if (steps.length < 2) {
        return inconclusive([`the capper answered in step 1 with no tool call, so maxTurns 2 was not reached`]);
      }
      return expectAll(
        {
          'exactly 2 steps': steps.length === 2,
          'reason answer, not aborted': end.reason === 'answer' && end.isAborted === false,
          'answer ""': end.answer === '',
        },
        [
          `${agentId}: steps ${steps.map((event) => event.index).join(',')}; ${end.reason} ` +
            `answer=${JSON.stringify(end.answer)}`,
        ]
      );
    },
  },

  // --- spawn sites (spec §7.2, §10.3) ---
  {
    id: 'rr-spawn-step',
    title: 'A spawn at main turn.step index >= 1 acts as at index 0: it runs; only the spawning on() misses its events',
    source: '§16.5: spawn sites (a spawn at turn.step index ≥ 1)',
    kind: 'deterministic',
    scenario: 'rr-spawn',
    verify: (obs) => {
      if (!obs.probe) {
        return fail(['no rr-spawn.json', clip(obs.p?.stderr ?? '', 180)]);
      }
      const site = obs.probe.sites?.step;
      if (!site) {
        return inconclusive([`no main step with index >= 1: no tool round in ${obs.probe.mainStarts} main turns`]);
      }
      if (!site.agentId) {
        return fail([`the spawn at index ${site.index} did not resolve: ${clip(spawnText(site), 200)}`]);
      }
      const facts = siteFacts(obs, site.agentId);
      return expectAll(
        {
          [`the spawn at index ${site.index} resolves`]: true,
          "the agent's turn.complete reaches the module": facts.complete > 0,
          "another registration (on('*')) sees the agent's turn.step": facts.witnessSteps > 0,
          "the spawning on('turn.step') sees none of them": facts.stepHook === 0,
          "the module's on('tool.call') sees the agent's tool calls (the note path)":
            facts.agentTools === 0 || facts.toolHook > 0,
        },
        [factLine('step', site.agentId, facts)]
      );
    },
  },
  {
    id: 'rr-spawn-tool',
    title: 'A spawn from a tool.call hook runs; the spawning on() misses its tool calls, the others see them',
    source: '§16.5: spawn sites (a spawn from a tool.call hook)',
    kind: 'advisory',
    scenario: 'rr-spawn',
    verify: (obs) => {
      const site = obs.probe?.sites?.tool;
      if (!site) {
        return inconclusive(['the main loop made no Read call, so the tool.call site never ran']);
      }
      if (!site.agentId) {
        return fail([`the spawn did not resolve: ${clip(spawnText(site), 200)}`]);
      }
      const facts = siteFacts(obs, site.agentId);
      const line = factLine('tool', site.agentId, facts);
      if (facts.agentTools === 0) {
        return inconclusive(['the agent made no tool call', line]);
      }
      return expectAll(
        {
          "the agent's turn.complete reaches the module": facts.complete > 0,
          "on('turn.step') sees the agent's steps": facts.stepHook > 0,
          "the spawning on('tool.call') sees none of its tool calls": facts.toolHook === 0,
          "on('*') sees them": facts.witnessTools > 0,
        },
        [line]
      );
    },
  },
  {
    id: 'rr-spawn-clock',
    title: 'A $.clock.after spawn and submit while a main turn runs',
    source: '§16.5: spawn sites (a $.clock.after spawn or submit while a turn runs)',
    kind: 'advisory',
    scenario: 'rr-spawn',
    verify: (obs) => {
      const site = obs.probe?.sites?.busy;
      if (!site) {
        return inconclusive([`the busy clock never ran (phase ${obs.probe?.phase ?? 'none'})`]);
      }
      if (!site.duringTurn) {
        return inconclusive(['the clock fired after the turn ended: the model answered at once']);
      }
      return pass([siteLine(obs, 'busy', site), submitLine(site), submittedTurn(obs, 'CLOCKED')]);
    },
  },
  {
    id: 'rr-spawn-alive',
    title: 'A -p session kept open by stream-json input runs a $.clock.after callback past the turn',
    source: '§16.5: spawn sites (a -p session that stays alive past a clock)',
    kind: 'advisory',
    scenario: 'rr-spawn',
    verify: (obs) => {
      const site = obs.probe?.sites?.idle;
      if (!site) {
        return fail([
          'the 3 s clock after the last main turn.complete never ran while stdin was open',
          `exit ${obs.p?.exitCode}, ${obs.p?.wallMs} ms`,
        ]);
      }
      return pass([
        `the clock ran while -p idled (duringTurn ${site.duringTurn})`,
        siteLine(obs, 'idle', site),
        submitLine(site),
        submittedTurn(obs, 'IDLED'),
      ]);
    },
  },

  // --- read scope (spec §6.5) ---
  {
    id: 'rr-ceiling',
    title: 'tool.check carries the ceiling an org sets, on the question and on the verdict',
    source: '§16.5: read scope (a tool.check ceiling that an org sets)',
    kind: 'deterministic',
    scenario: 'rr-ceiling',
    needs: ['org:ceiling'],
    verify: (obs) => {
      if (!obs.probe) {
        return fail(['no rr-ceiling.json', clip(obs.p?.stderr ?? '', 180)]);
      }
      const rows = obs.probe.sweeps.flatMap((sweep) => sweep.rows ?? []);
      const set = rows.filter((row) => CEILINGS.has(row.ceiling));
      const asked = ofEvent(obs.events, 'tool.check', (event) => CEILINGS.has(event.ceiling));
      return expectAll(
        {
          'a verdict carries a ceiling': set.length > 0,
          'a tool.check hook reads it on the question (e.ceiling)': asked.length > 0,
        },
        [
          `${rows.length} verdicts in ${obs.probe.sweeps.length} sweeps, ${rows.filter((row) => row.mcp).length} MCP`,
          `with a ceiling: ${clip(set.map((row) => `${row.tool} ${row.ceiling}/${row.decision}`).join(', '), 220)}`,
        ]
      );
    },
  },
  {
    id: 'rr-ceiling-cap',
    title: 'Whether a ceiling caps the allow of a tool.check hook (the watchdog read-scope allow)',
    source: '§16.5: read scope (a tool.check ceiling that an org sets)',
    kind: 'advisory',
    scenario: 'rr-ceiling',
    needs: ['org:ceiling'],
    verify: (obs) => {
      const forced = obs.probe?.forced ?? [];
      if (forced.length === 0) {
        return inconclusive(['no tool had a ceiling, so no hook allow was tried']);
      }
      return pass(
        forced
          .slice(0, 6)
          .map(
            (row) =>
              `${row.tool}: ceiling ${row.ceiling}, engine ${row.before}, after a hook allow ${row.decision}` +
              ` (${row.decision === 'allow' ? 'not capped' : 'capped'})`
          )
      );
    },
  },

  // --- roster and tools ---
  {
    id: 'rr-roster-unknown',
    title: 'Unknown WATCHDOG.json keys are dropped with a warning each, and the entry stays',
    source: '§16.5: roster and tools (unknown roster keys are ignored)',
    kind: 'deterministic',
    scenario: 'rr-roster',
    verify: (obs) => {
      if (!obs.status) {
        return fail(['no /watchdog status reply', obs.run.logs]);
      }
      const text = String(obs.status.text ?? '');
      const registered = ofEvent(obs.events, 'agent.register', (event) => event.name === 'probe');
      // §4.6, §13.2: one row with the count; at least these 2 (another file of the person's could add more).
      const counts = ofEvent(obs.events, 'ui.log').map((event) =>
        Number(/(\d+) WATCHDOG\.json warnings?; see \/watchdog status/u.exec(event.text ?? '')?.[1] ?? 0)
      );
      return expectAll(
        {
          'status warns: unknown key "rrUnknown" dropped': /^warning: .*unknown key "rrUnknown" dropped$/mu.test(text),
          'status warns: watchdog "probe": unknown key "rrEntryUnknown" dropped':
            /^warning: .*watchdog "probe": unknown key "rrEntryUnknown" dropped$/mu.test(text),
          'the entry stays: probe registers': registered.length > 0,
          'the entry stays: status lists probe': /^probe .*WATCHDOG\.json/mu.test(text),
          'one log row counts the warnings': counts.some((count) => count >= 2),
        },
        [clip(text.replaceAll('\n', ' | '), 280), `warning-count rows: ${counts.filter(Boolean).join(', ') || 'none'}`]
      );
    },
  },
  {
    id: 'rr-deny-project',
    title: 'Project permissions.deny Agent(x) and the legacy Task(x) block the spawn with the scoped deny text',
    source: '§16.5: roster and tools (a deny and the legacy Task names act the same)',
    kind: 'deterministic',
    scenario: 'rr-deny',
    verify: (obs) => {
      const lost = noDenyResult([obs.scoped]);
      if (lost) {
        return lost;
      }
      return expectAll(
        {
          'Agent(rrdeny:kp): blocked': isScoped(obs.scoped, 'kp'),
          'Task(rrdeny:kpt): blocked the same way': isScoped(obs.scoped, 'kpt'),
          'control: an agent that no rule names spawns': Boolean(spawnOf(obs.scoped, 'ok')?.agentId),
        },
        [denyLine('Agent(x)', obs.scoped, 'kp'), denyLine('Task(x)', obs.scoped, 'kpt')]
      );
    },
  },
  {
    id: 'rr-deny-cli',
    title: '--disallowedTools Agent, Task, Agent(x) and Task(x) block the spawn as a settings deny does',
    source: '§16.5: roster and tools (a deny in --disallowedTools and the legacy Task names act the same)',
    kind: 'deterministic',
    scenario: 'rr-deny',
    verify: (obs) => {
      const lost = noDenyResult([obs.cliAgent, obs.cliTask, obs.scoped]);
      if (lost) {
        return lost;
      }
      return expectAll(
        {
          'Agent: the spawn rejects with no tool named "Agent"': isWholeDeny(obs.cliAgent),
          'Task: the same reject': isWholeDeny(obs.cliTask),
          'Agent(rrdeny:kc): the scoped deny text': isScoped(obs.scoped, 'kc'),
          'Task(rrdeny:kct): the same scoped deny text': isScoped(obs.scoped, 'kct'),
        },
        [
          denyLine('Agent', obs.cliAgent, 'keeper'),
          denyLine('Task', obs.cliTask, 'keeper'),
          denyLine('Agent(x)', obs.scoped, 'kc'),
          denyLine('Task(x)', obs.scoped, 'kct'),
        ]
      );
    },
  },
  {
    id: 'rr-deny-managed',
    title: 'A managed-settings deny of Agent, Agent(x) and Task(x) blocks the spawn as a project deny does',
    source: '§16.5: roster and tools (a deny in managed settings acts the same)',
    kind: 'deterministic',
    scenario: 'rr-deny',
    verify: (obs) => {
      const lost = noDenyResult([obs.managed, obs.scoped]);
      if (lost) {
        return lost;
      }
      const lines = [
        denyLine('Agent', obs.managed, 'keeper'),
        denyLine('Agent(x)', obs.scoped, 'km'),
        denyLine('Task(x)', obs.scoped, 'kmt'),
      ];
      const isApplied = ['keeper', 'km', 'kmt'].some(
        (name) => !spawnOf(name === 'keeper' ? obs.managed : obs.scoped, name)?.agentId
      );
      // No rule applied: a server-managed or admin tier on this machine takes the policy tier (lib/env.mjs), so the
      // parent tier never applies here. With no such tier, the ignored deny is a real finding.
      if (!isApplied) {
        const tier = managedTier();
        return tier
          ? inconclusive([`no --managed-settings rule applied: ${tier} takes the policy tier`, ...lines])
          : fail(['no --managed-settings rule applied, and no other policy tier is installed', ...lines]);
      }
      return expectAll(
        {
          'Agent: the spawn rejects with no tool named "Agent"': isWholeDeny(obs.managed),
          'Agent(rrdeny:km): the scoped deny text': isScoped(obs.scoped, 'km'),
          'Task(rrdeny:kmt): the same scoped deny text': isScoped(obs.scoped, 'kmt'),
        },
        lines
      );
    },
  },
  {
    id: 'rr-deny-user',
    title: 'A user-settings deny of Agent, Agent(x) and Task(x) blocks the spawn as a project deny does',
    source: '§16.5: roster and tools (a deny in user settings acts the same)',
    kind: 'deterministic',
    scenario: 'rr-deny-user',
    verify: (obs) => {
      const lost = noDenyResult([obs.whole, obs.scoped]);
      if (lost) {
        return lost;
      }
      return expectAll(
        {
          'Agent: the spawn rejects with no tool named "Agent"': isWholeDeny(obs.whole),
          'Agent(rrdeny:ku): the scoped deny text': isScoped(obs.scoped, 'ku'),
          'Task(rrdeny:kut): the same scoped deny text': isScoped(obs.scoped, 'kut'),
          'control: an agent that no rule names spawns': Boolean(spawnOf(obs.scoped, 'ok')?.agentId),
        },
        [
          denyLine('Agent', obs.whole, 'keeper'),
          denyLine('Agent(x)', obs.scoped, 'ku'),
          denyLine('Task(x)', obs.scoped, 'kut'),
        ]
      );
    },
  },
  {
    id: 'rr-perm-parent',
    title: 'A bypassPermissions or auto parent acts like acceptEdits: it wins over the agent dontAsk (Edit, Write)',
    source: '§16.5: roster and tools (an auto or bypassPermissions parent acts like acceptEdits)',
    kind: 'advisory',
    scenario: 'rr-perm',
    verify: (obs) => {
      const lines = [obs.base, obs.bypass, obs.auto].map(permLine);
      const base = permOutcome(obs.base);
      if (base === null) {
        return inconclusive(['the default-parent editor did not call both Edit and Write', ...lines]);
      }
      if (base !== 'refused') {
        return inconclusive(["the default parent did not refuse both, so the agent's dontAsk did not apply", ...lines]);
      }
      // Each parent mode that started (stream-json init): it wins over the agent's dontAsk, as acceptEdits does.
      const parents = [
        ['bypassPermissions', obs.bypass],
        ['auto', obs.auto],
      ].map(([mode, session]) => ({
        mode,
        isStarted: session.p?.init?.permissionMode === mode,
        outcome: permOutcome(session),
        stderr: session.p?.stderr ?? '',
      }));
      const failed = parents.filter((item) => item.isStarted && item.outcome !== null && item.outcome !== 'wins');
      if (failed.length > 0) {
        return fail([...failed.map((item) => `${item.mode} did not act like acceptEdits: ${item.outcome}`), ...lines]);
      }
      const open = parents.filter((item) => !item.isStarted || item.outcome === null);
      return open.length === 0
        ? pass(lines)
        : inconclusive([
            ...open.map((item) =>
              item.isStarted
                ? `${item.mode}: the editor did not call both Edit and Write`
                : `${item.mode} did not start: ${clip(item.stderr, 140)}`
            ),
            ...lines,
          ]);
    },
  },
  {
    id: 'rr-perm-edit',
    title: 'Edit follows the Write path: under each parent mode both get the same verdict and outcome',
    source: '§16.5: roster and tools (Edit follows the Write path)',
    kind: 'advisory',
    scenario: 'rr-perm',
    verify: (obs) => {
      const sessions = [obs.base, obs.bypass, obs.auto];
      const pairs = sessions
        .map((session) => ({ session, edit: editorCall(session, 'Edit'), write: editorCall(session, 'Write') }))
        .filter((pair) => pair.edit && pair.write);
      if (pairs.length === 0) {
        return inconclusive(['no editor called both Edit and Write', ...sessions.map(permLine)]);
      }
      // The refusal text names its tool; the rest of it is the path's.
      const form = (call) => call.text.replaceAll(call.tool, '<tool>').slice(0, 90);
      const isSame = ({ edit, write }) =>
        edit.isError === write.isError &&
        edit.decision === write.decision &&
        (!edit.isError || form(edit) === form(write));
      const differ = pairs.filter((pair) => !isSame(pair));
      const lines = pairs.map(
        ({ session, edit, write }) =>
          `${session.name}: Edit ${edit.decision}/${edit.isError ? 'refused' : 'ran'}, Write ${write.decision}/` +
          `${write.isError ? 'refused' : 'ran'}${edit.isError ? `; ${clip(form(edit), 90)}` : ''}`
      );
      return differ.length === 0
        ? pass(lines)
        : fail([`Edit and Write differ under ${differ.map(({ session }) => session.name).join(', ')}`, ...lines]);
    },
  },
  {
    id: 'rr-tools-disallowed',
    title: 'An agent disallowedTools of Bash, Edit and Write removes them from its API request (spec §6.1)',
    source: '§16.5: roster and tools (a tools list without Bash, Edit, Write blocks them like disallowedTools)',
    kind: 'deterministic',
    scenario: 'rr-perm',
    verify: (obs) => {
      const tools = obs.base.agentTools?.denied;
      if (!tools) {
        return fail(['no request body of the `denied` agent', clip(flat(obs.base.probe?.spawns?.denied), 200)]);
      }
      return expectAll(
        {
          'no Bash, Edit or Write in the request': BANNED_TOOLS.every((tool) => !tools.includes(tool)),
          'Read and Glob stay': tools.includes('Read') && tools.includes('Glob'),
        },
        [`denied agent tools: ${tools.join(', ')}`]
      );
    },
  },
  {
    id: 'rr-tools-allowlist',
    title: 'A tools list without Bash, Edit and Write gives the same request tools as disallowedTools',
    source: '§16.5: roster and tools (a tools list without Bash, Edit, Write blocks them like disallowedTools)',
    kind: 'advisory',
    scenario: 'rr-perm',
    verify: (obs) => {
      const listed = obs.base.agentTools?.listed;
      const denied = obs.base.agentTools?.denied;
      if (!listed || !denied) {
        return inconclusive(['a tool-list agent sent no request', clip(flat(obs.base.probe?.spawns), 200)]);
      }
      const same = [...listed].sort().join(',') === [...denied].sort().join(',');
      return expectAll(
        {
          'no Bash, Edit or Write in the request': BANNED_TOOLS.every((tool) => !listed.includes(tool)),
          'the same tools as the disallowedTools agent': same,
        },
        [`listed agent tools: ${listed.join(', ')}`, `denied agent tools: ${denied.join(', ')}`]
      );
    },
  },

  // --- the namespace of a $.command name ---
  {
    id: 'rr-command-namespace',
    title: 'A $.command name a mod registers runs as typed: /watchdog status, with no plugin prefix',
    source: '§16.5: the namespace of a $.command name that a mod registers',
    kind: 'deterministic',
    scenario: 'tui-review',
    verify: (obs) => {
      if (!obs.status) {
        return inconclusive(['tui-review did not reach /watchdog status']);
      }
      const isStatus = (event) => event.command === 'watchdog' && event.args === 'status';
      const typed = ofEvent(obs.events, 'command.run.in', isStatus);
      const screen = String(obs.screens?.status ?? '');
      return expectAll(
        {
          'the command that ran is watchdog with args status':
            obs.status.command === 'watchdog' && obs.status.args === 'status',
          'it came from the composer (the person typed it)': typed.some((event) => event.origin?.kind === 'composer'),
          'the screen echoes the typed /watchdog status': /❯ \/watchdog status\s*$/mu.test(screen),
          'no unknown-command reply': !/Unknown (?:slash )?command|Unknown skill/iu.test(screen),
        },
        [
          `command.run.in ${typed.length}x, origin ${flat(typed[0]?.origin)}`,
          `reply: ${clip(String(obs.status.text ?? '').split('\n')[0], 120)}`,
        ]
      );
    },
  },
];
