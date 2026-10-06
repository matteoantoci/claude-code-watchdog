// §16.5 the caps in the TUI (spec §12.2; research/stop-caps-probe.md P2). With CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=1
// and rr-stop's holder in the only session slot, this plugin's own per-plugin count is 0, so the session cap (shared
// by every plugin and the primary agent) is the one that refuses its spawn. It acts at the main turn.complete of the
// prompt that carries RRPEER. installMod fills __LOG__ and __HOLD__ (the proxy holds the agent if it ever runs; it is
// then stopped at once). Result: __LOG__/rr-peer.json.
const FILE = '__LOG__/rr-peer.json';
const HOLD = '__HOLD__';
const PLUGIN = 'rrpeer';
const MARKER = 'RRPEER';

const state = { phase: 'idle' };
let lastText = '';

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 800) });

const spawnPeer = async ($) => {
  try {
    const resolved = await $.agent.spawn({
      subagentType: `${PLUGIN}:peer`,
      description: 'probe peer',
      prompt: 'Reply OK.',
    });
    state.spawn = { agentId: resolved?.agentId ?? null, resolved };
  } catch (err) {
    state.spawn = { agentId: null, rejected: errOf(err) };
  }
  if (state.spawn.agentId) {
    try {
      state.cleanup = await $.tool.call({ tool: 'TaskStop', task_id: state.spawn.agentId });
    } catch (err) {
      state.cleanup = { rejected: errOf(err) };
    }
  }
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.agent.register({
        name: 'peer',
        description: 'Cap probe agent of a second plugin. The probe spawns it; do not delegate to it.',
        prompt: `${HOLD}. Reply OK. Do not call tools.`,
        tools: [],
        model: 'haiku',
        omitClaudeMd: true,
        background: true,
        maxTurns: 1,
      });
    } catch (err) {
      state.registerError = errOf(err);
    }
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
    if (!e.agentId && state.phase === 'idle' && lastText.includes(MARKER)) {
      state.phase = 'acting';
      state.at = Date.now();
      await spawnPeer($);
      state.phase = 'done';
      await $.fs.write(FILE, JSON.stringify(state)).catch(() => undefined);
    }
    return result;
  });
};
