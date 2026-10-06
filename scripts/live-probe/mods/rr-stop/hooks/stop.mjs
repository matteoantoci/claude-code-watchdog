// §16.5 review stop and spawn caps (spec §7.8, §12.2; research/stop-caps-probe.md "What I did not check").
// installMod fills __LOG__, __MODE__ (`headless` or `tui`) and __HOLD__, the proxy's agentMark: each request of a
// `holder` agent gets a 529 from the proxy, so the agent waits on the model until it is stopped, at no token cost.
// Each phase runs in the main turn.complete hook (a live frame) of the prompt whose text carries its marker.
// Result: one JSON object at __LOG__/rr-stop.json.
//
// headless, default caps (no CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS):
//   RRSTOP1  TaskStop on an unknown id; holders until the per-plugin cap refuses one; TaskStop on the first holder
//            while it waits on the model, then once more at once.
//   RRSTOP2  TaskStop on that stopped holder; a spawn into the slot it freed (`ender`, a real model call); TaskStop
//            on the other holders.
//   RRSTOP3  TaskStop on `ender`, which ended by itself.
// tui, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=1:
//   RRHOLD   one holder, then a spawn that the per-plugin cap refuses.
//   RRPEER   the rr-peer plugin (inner, so it acts first) meets the session cap; then the holder stops.
//   RRCAP    a `capper` agent with maxTurns 2 in the slot the stop freed.
const FILE = '__LOG__/rr-stop.json';
const PEER_FILE = '__LOG__/rr-peer.json';
const MODE = '__MODE__';
const HOLD = '__HOLD__';
const PLUGIN = 'rrstop';
// Shaped like an agent id (`a` + 16 hex), but no task has it.
const UNKNOWN_ID = 'a0123456789abcdef';
const MAX_HOLDERS = 25;
const CAPPER_TASK =
  'In every reply, write one line that starts with "ROUND <n>:" and call the Glob tool with pattern "*.txt". ' +
  'Do 5 rounds.';

const state = { mode: MODE, phase: 'idle', pending: null };
let lastText = '';
let writing = Promise.resolve();

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 800) });

const write = ($) => {
  writing = writing.then(() => $.fs.write(FILE, JSON.stringify(state))).catch(() => undefined);
  return writing;
};

// One awaited step; `pending` names it until it settles, so a call that never settles shows in the result.
const step = async ($, key, fn) => {
  state.pending = key;
  await write($);
  state[key] = await fn();
  state.pending = null;
  await write($);
  return state[key];
};

const spawn = async ($, tag, type, prompt) => {
  const at = Date.now();
  try {
    const resolved = await $.agent.spawn({ subagentType: `${PLUGIN}:${type}`, description: `probe ${tag}`, prompt });
    return { tag, at, agentId: resolved?.agentId ?? null, resolved };
  } catch (err) {
    return { tag, at, agentId: null, rejected: errOf(err) };
  }
};

// §7.8: the stop route; the task id is the agentId.
const taskStop = async ($, agentId) => {
  const at = Date.now();
  try {
    const resolved = await $.tool.call({ tool: 'TaskStop', task_id: agentId });
    return { agentId, at, ms: Date.now() - at, resolved };
  } catch (err) {
    return { agentId, at, ms: Date.now() - at, rejected: errOf(err) };
  }
};

const statusOf = async ($, agentId) => {
  try {
    const list = await $.agent.list();
    const row = (Array.isArray(list) ? list : []).find((agent) => agent.id === agentId);
    return row?.status ?? 'absent';
  } catch (err) {
    return `list-error: ${String(err?.message ?? err).slice(0, 200)}`;
  }
};

// §12.2: holders until the per-plugin cap refuses one (`over`); `running` is how many held then.
const holdUntilCap = async ($) => {
  state.holders = [];
  for (let i = 1; i <= MAX_HOLDERS && !state.over; i += 1) {
    const spawned = await spawn($, `holder ${i}`, 'holder', `Reply with exactly HELD${i}.`);
    if (spawned.agentId) {
      state.holders.push(spawned.agentId);
    } else {
      state.over = { ...spawned, running: state.holders.length };
    }
  }
  await write($);
};

// RRSTOP1. The 1.5 s sleep lets the first holder's request reach the proxy and get its 529 (retry-after 20 s).
const stopFirst = async ($) => {
  await step($, 'unknown', () => taskStop($, UNKNOWN_ID));
  await holdUntilCap($);
  const first = state.holders[0];
  if (first) {
    await $.clock.sleep(1500);
    state.stopAt = Date.now();
    await step($, 'stopLive', () => taskStop($, first));
    await step($, 'stopTwice', () => taskStop($, first));
  }
  state.phase = 'stopped';
};

// RRSTOP2: a later dispatch, after the stopped holder's turn.complete, so its slot had time to free.
const stopEnded = async ($) => {
  const first = state.holders?.[0];
  if (first) {
    state.killedStatus = await statusOf($, first);
    await step($, 'stopEnded', () => taskStop($, first));
    await step($, 'slot', () => spawn($, 'ender', 'ender', 'Reply with exactly ENDED.'));
  }
  state.cleanup = [];
  for (const agentId of (state.holders ?? []).slice(1)) {
    const stopped = await taskStop($, agentId);
    state.cleanup.push({ agentId, isStopped: String(stopped.resolved?.text ?? '').includes('Successfully stopped') });
  }
  state.ender = state.slot?.agentId ? state.slot : await spawn($, 'ender', 'ender', 'Reply with exactly ENDED.');
  state.phase = state.ender.agentId ? 'ender' : 'done';
};

// RRSTOP3: `ender` answered and ended on its own before this prompt.
const stopComplete = async ($) => {
  state.enderStatus = await statusOf($, state.ender.agentId);
  await step($, 'stopComplete', () => taskStop($, state.ender.agentId));
  state.phase = 'done';
};

const tuiHold = async ($) => {
  await holdUntilCap($);
  state.phase = 'held';
};

// RRPEER: rr-peer's hook is inner, so its spawn settled already; wait up to 3 s for its file all the same.
const tuiPeer = async ($) => {
  for (let i = 0; i < 15 && !(await $.fs.exists(PEER_FILE).catch(() => false)); i += 1) {
    await $.clock.sleep(200);
  }
  const first = state.holders?.[0];
  if (first) {
    state.stopAt = Date.now();
    await step($, 'stopLive', () => taskStop($, first));
  }
  state.phase = 'stopped';
};

const tuiCap = async ($) => {
  await step($, 'capper', () => spawn($, 'capper', 'capper', CAPPER_TASK));
  state.phase = 'done';
};

// [marker, phase it starts from, action]
const PHASES =
  MODE === 'tui'
    ? [
        ['RRHOLD', 'idle', 'hold'],
        ['RRPEER', 'held', 'peer'],
        ['RRCAP', 'stopped', 'cap'],
      ]
    : [
        ['RRSTOP1', 'idle', 'first'],
        ['RRSTOP2', 'stopped', 'ended'],
        ['RRSTOP3', 'ender', 'complete'],
      ];

// Each action is called by name: `claude plugin validate` refuses `$` passed through a dynamic call.
const act = async ($, action) => {
  if (action === 'hold') {
    await tuiHold($);
  } else if (action === 'peer') {
    await tuiPeer($);
  } else if (action === 'cap') {
    await tuiCap($);
  } else if (action === 'first') {
    await stopFirst($);
  } else if (action === 'ended') {
    await stopEnded($);
  } else {
    await stopComplete($);
  }
};

const onMainComplete = async ($) => {
  const phase = PHASES.find(([marker, from]) => lastText.includes(marker) && state.phase === from);
  if (!phase) {
    return;
  }
  state.phase = 'acting';
  try {
    await act($, phase[2]);
  } catch (err) {
    state.error = errOf(err);
    state.phase = 'error';
  }
  await write($);
};

const AGENTS = [
  {
    name: 'holder',
    description: 'Stop probe agent, held by the proxy. The probe spawns it; do not delegate to it.',
    prompt: `${HOLD}. Reply with the exact word the task asks for. Do not call tools.`,
    tools: [],
    maxTurns: 1,
  },
  {
    name: 'ender',
    description: 'Stop probe agent that ends by itself. The probe spawns it; do not delegate to it.',
    prompt: 'Reply with the exact word the task asks for. Do not call tools.',
    tools: [],
    maxTurns: 1,
  },
  {
    name: 'capper',
    description: 'maxTurns probe agent. The probe spawns it; do not delegate to it.',
    prompt: 'Follow the task. Call Glob when it says to.',
    tools: ['Glob'],
    maxTurns: 2,
  },
];

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    for (const agent of AGENTS) {
      try {
        await $.agent.register({ ...agent, model: 'haiku', omitClaudeMd: true, background: true });
      } catch (err) {
        state.registerError = errOf(err);
      }
    }
    await write($);
    return next(e);
  });

  on('agent.offer', async ($, e, next) =>
    String(e.agent ?? '').startsWith(`${PLUGIN}:`) ? { isOffered: false } : next(e)
  );

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      lastText = String(e.text ?? '');
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      await onMainComplete($);
    }
    return result;
  });
};
