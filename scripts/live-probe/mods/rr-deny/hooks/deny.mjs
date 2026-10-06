// §16.5 roster and tools: a deny in user settings, managed settings or --disallowedTools, and the legacy Task
// names, act the same (spec §12.2; research/smoke-agent-deny.md). installMod fills __LOG__ and __TYPES__, a comma
// list of agent names to spawn, one after another, at the first main turn.complete. The session's deny rules name
// some of them (`Agent(rrdeny:<name>)`, `Task(rrdeny:<name>)`) or the whole tool (`Agent`, `Task`); `ok` is named by
// no rule. Result: __LOG__/rr-deny.json: `hasAgentTool` (from $.tool.list) and `spawns`, one result per name.
const FILE = '__LOG__/rr-deny.json';
const PLUGIN = 'rrdeny';
const TYPES = '__TYPES__'.split(',').filter(Boolean);

const state = { phase: 'idle', spawns: {} };

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 800) });

const spawn = async ($, name) => {
  try {
    const resolved = await $.agent.spawn({
      subagentType: `${PLUGIN}:${name}`,
      description: `probe ${name}`,
      prompt: 'Reply OK.',
    });
    return { agentId: resolved?.agentId ?? null, resolved };
  } catch (err) {
    return { agentId: null, rejected: errOf(err) };
  }
};

const toolNames = async ($) => {
  try {
    return (await $.tool.list()).map((tool) => tool.name);
  } catch (err) {
    state.listError = errOf(err);
    return [];
  }
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    for (const name of TYPES) {
      try {
        await $.agent.register({
          name,
          description: `Deny probe agent ${name}. The probe spawns it; do not delegate to it.`,
          prompt: 'Reply OK. Do not call tools.',
          tools: [],
          model: 'haiku',
          omitClaudeMd: true,
          background: true,
          maxTurns: 1,
        });
      } catch (err) {
        state.registerError = errOf(err);
      }
    }
    return next(e);
  });

  on('agent.offer', async ($, e, next) =>
    String(e.agent ?? '').startsWith(`${PLUGIN}:`) ? { isOffered: false } : next(e)
  );

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && state.phase === 'idle') {
      state.phase = 'acting';
      const names = await toolNames($);
      state.hasAgentTool = names.includes('Agent') || names.includes('Task');
      for (const name of TYPES) {
        state.spawns[name] = await spawn($, name);
      }
      state.phase = 'done';
      await $.fs.write(FILE, JSON.stringify(state)).catch(() => undefined);
    }
    return result;
  });
};
