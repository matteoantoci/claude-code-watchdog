// §16.5 model compare (§12.2): one agent of this probe mod, registered with the model __MODEL__ and spawned once at
// the first main-loop turn end. It shows the model the engine runs for that alias (spawn result, `turn.step`,
// `usage.model`) apart from the watchdog plugin, whose preflight `$.model.complete` can refuse the alias before any
// spawn (§5.2). The observer logs the spawn, the steps and the end; this file logs the register and the spawn
// result to __LOG__/rf-model.json. A hooks module cannot import node:fs (§16.3).
const FILE = '__LOG__/rf-model.json';
const PLUGIN = 'rfmodel';
const state = { model: '__MODEL__', register: null, spawn: null };
let writing = Promise.resolve();

const errorOf = (error) => String(error?.message ?? error).slice(0, 800);

const write = ($) => {
  writing = writing.then(() => $.fs.write(FILE, `${JSON.stringify(state)}\n`)).catch(() => undefined);
  return writing;
};

export const register = (on) => {
  // §16.4 #6: a register in `session.start` resolves; the agent takes no tool and one turn.
  on('session.start', async ($, e, next) => {
    state.register = await $.agent
      .register({
        name: 'probe',
        description: 'Model probe agent. Only the probe spawns it; never delegate to it.',
        prompt: 'Reply with the single word OK. Do not call any tool.',
        tools: [],
        model: state.model,
        effort: 'low',
        maxTurns: 1,
        omitClaudeMd: true,
        background: true,
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error: errorOf(error) })
      );
    await write($);
    return next(e);
  });

  on('agent.offer', async ($, e, next) =>
    String(e.agent ?? '').startsWith(`${PLUGIN}:`) ? { isOffered: false } : next(e)
  );

  // §7.2: the main `turn.complete` is a spawn site; the spawn is awaited in the live hook.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && state.spawn === null && state.register?.value !== undefined) {
      state.spawn = 'pending';
      state.spawn = await $.agent
        .spawn({
          subagentType: `${PLUGIN}:probe`,
          description: 'rf model probe',
          prompt: 'Reply with the single word OK. Do not call any tool.',
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error: errorOf(error) })
        );
      await write($);
    }
    return result;
  });
};
