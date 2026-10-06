// §16.5 spawn sites (spec §7.2, §10.3; research/spawn-sites.md "Not checked"). One -p session that stream-json input
// keeps open. installMod fills __LOG__. Four sites, each spawning one `reviewer` (tool Glob):
//   step  the main turn.step hook at index >= 1, awaited before the hook returns (a live frame);
//   tool  the tool.call hook of the main loop's Read, awaited before the hook returns (a live frame);
//   busy  a $.clock.after callback armed at main step 0, so it spawns and submits while that turn runs;
//   idle  a $.clock.after callback 3 s after the last main turn.complete, while -p is idle but still open.
// The `on('*')` registration is the witness: it counts each agent's events that reach this module through another
// registration than the spawning one. `stepHook`, `toolHook` and `completeHook` count what the turn.step, tool.call
// and turn.complete registrations themselves saw of each agent. Result: __LOG__/rr-spawn.json.
const FILE = '__LOG__/rr-spawn.json';
const PLUGIN = 'rrspawn';
const BUSY_MS = 400;
const IDLE_MS = 3000;
const IDLE_TRIES = 20;
const SUBMITS = { busy: 'Reply with the single word CLOCKED.', idle: 'Reply with the single word IDLED.' };

const state = {
  phase: 'idle',
  turnRunning: false,
  mainStarts: 0,
  mainCompletes: 0,
  sites: {},
  ends: {},
  witness: {},
  stepHook: {},
  toolHook: {},
  completeHook: {},
};
let idleTimer = null;
let idleTries = 0;
let writing = Promise.resolve();

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 800) });

const write = ($) => {
  writing = writing.then(() => $.fs.write(FILE, JSON.stringify(state))).catch(() => undefined);
  return writing;
};

const bump = (map, agentId, key = 'count') => {
  map[agentId] = map[agentId] ?? {};
  map[agentId][key] = (map[agentId][key] ?? 0) + 1;
};

const spawn = async ($, tag) => {
  const at = Date.now();
  try {
    const resolved = await $.agent.spawn({
      subagentType: `${PLUGIN}:reviewer`,
      description: `probe ${tag}`,
      prompt: `Call the Glob tool once with pattern "*.txt". Then reply with exactly DONE-${tag}.`,
    });
    return { tag, at, agentId: resolved?.agentId ?? null, resolved };
  } catch (err) {
    return { tag, at, agentId: null, rejected: errOf(err) };
  }
};

// The busy and idle sites: a bare frame (§7.2), so no hook of this plugin sees what these calls cause.
const clockSite = async ($, tag) => {
  const duringTurn = state.turnRunning;
  const spawned = await spawn($, tag);
  let submit;
  try {
    submit = { resolved: await $.prompt.submit({ text: SUBMITS[tag] }) };
  } catch (err) {
    submit = { rejected: errOf(err) };
  }
  state.sites[tag] = { ...spawned, duringTurn, submit, doneAt: Date.now() };
  await write($);
};

// §10.3: the -p idle case. Re-armed while a main turn runs (the busy submit can start one), at most IDLE_TRIES times.
const onIdle = async ($) => {
  if (state.sites.idle) {
    return;
  }
  if (state.turnRunning && idleTries < IDLE_TRIES) {
    idleTries += 1;
    idleTimer = $.clock.after(IDLE_MS, () => onIdle($));
    return;
  }
  await clockSite($, 'idle');
};

const armIdle = ($) => {
  if (state.sites.idle) {
    return;
  }
  idleTimer?.cancel();
  idleTimer = $.clock.after(IDLE_MS, () => onIdle($));
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.agent.register({
        name: 'reviewer',
        description: 'Spawn-site probe agent. The probe spawns it; do not delegate to it.',
        prompt: 'Do the task in as few steps as it says. Use only the tool it names.',
        tools: ['Glob'],
        model: 'haiku',
        omitClaudeMd: true,
        background: true,
        maxTurns: 3,
      });
    } catch (err) {
      state.registerError = errOf(err);
    }
    await write($);
    return next(e);
  });

  on('agent.offer', async ($, e, next) =>
    String(e.agent ?? '').startsWith(`${PLUGIN}:`) ? { isOffered: false } : next(e)
  );

  // The witness: every event that carries an agent's id and reaches this registration.
  on('*', async ($, e, next) => {
    if (typeof e?.agentId === 'string' && e.agentId !== '') {
      bump(state.witness, e.agentId, next.event);
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      state.turnRunning = true;
      state.mainStarts += 1;
    }
    return next(e);
  });

  // §7.2: the step site spawns after its step's stream ended, before the hook returns.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      bump(state.stepHook, e.agentId);
      return yield* next(e);
    }
    const result = yield* next(e);
    if (e.index === 0 && !state.busyArmed) {
      state.busyArmed = true;
      $.clock.after(BUSY_MS, () => clockSite($, 'busy'));
    }
    if (e.index >= 1 && !state.sites.step) {
      state.sites.step = { ...(await spawn($, 'step')), index: e.index };
      await write($);
    }
    return result;
  });

  // The tool site: the main loop's Read, after its result, before the hook returns.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      bump(state.toolHook, e.agentId);
      return next(e);
    }
    const result = await next(e);
    if (e.tool === 'Read' && !state.sites.tool) {
      state.sites.tool = await spawn($, 'tool');
      await write($);
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) {
      bump(state.completeHook, e.agentId);
      const answer = String(e.answer ?? '').slice(0, 200);
      state.ends[e.agentId] = { reason: e.reason ?? null, answer, at: Date.now() };
    } else {
      state.turnRunning = false;
      state.mainCompletes += 1;
      armIdle($);
    }
    await write($);
    return result;
  });
};
