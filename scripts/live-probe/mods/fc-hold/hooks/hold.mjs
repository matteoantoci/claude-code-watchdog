// First check 4 (spec §16.4), adapted from prototypes/first-checks/hold. The main-loop `tool.call` for `Agent`, after
// `next(e)` resolved:
// - mode hold: wait 8 s inside the 10 s budget (`next.signal` ends the wait at Esc), then return `context`;
// - mode spin: keep the hooks worker busy for 12 s without yielding, so the engine replaces the worker and asks the
//   `.catch` in the new one (§8.3); the `.catch` returns its own `context`.
// The mode comes from the last person prompt: one with `FCSPIN-` spins, one with `FCHOLD-` holds. A worker respawn
// loads the module again, so each module instance logs to its own file `fc-hold-<instance>.jsonl`.
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const FILE = `__LOG__/fc-hold-${INSTANCE}.jsonl`;
const HOLD_MARKER = 'FCHOLD-ZEBRA8';
const SPIN_HOOK_MARKER = 'FCSPIN-HOOK0';
const CATCH_MARKER = 'FCSPIN-CATCH7';
const HOLD_MS = 8000;
const SPIN_MS = 12_000;
const lines = [];
let writing = null;
let mode = 'hold';

const log = ($, ev, data) => {
  lines.push(JSON.stringify({ t: Date.now(), inst: INSTANCE, ev, ...data }));
  const text = `${lines.join('\n')}\n`;
  writing = (writing ?? Promise.resolve()).then(() => $.fs.write(FILE, text)).catch(() => undefined);
  return writing;
};

const reasonOf = (signal) => {
  const reason = signal?.reason;
  return reason === undefined ? null : String(reason?.message ?? reason);
};

// The prototype's framing, so the primary reads the word as a plugin's test word.
const codeWord = (word) => `Test code word from the probe plugin: ${word}`;

// §11.3: what the engine answered the Agent call with (a foreground report, or the launch ack of a background run).
const resultFacts = (result) => ({
  isAsync: result?.result?.isAsync ?? null,
  status: result?.result?.status ?? null,
  text: String(result?.text ?? '').slice(0, 120),
});

const isMainAgentCall = (e) =>
  e.tool === 'Agent' && !e.agentId && !String(e.tool_use_id ?? '').startsWith('toolu_plugin_');

export const register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    const text = String(e.text ?? '');
    if (text.includes('FCSPIN-')) {
      mode = 'spin';
    } else if (text.includes('FCHOLD-')) {
      mode = 'hold';
    }
    return next(e);
  });
  // §11.3: whether the engine runs the main Agent call in the background.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e);
    if (!e.parentAgentId) {
      await log($, 'spawn', {
        subagentType: e.subagentType,
        background: e.background ?? null,
        agentId: result?.agentId ?? null,
      });
    }
    return result;
  });
  on('tool.call', async ($, e, next) => {
    if (!isMainAgentCall(e)) {
      return next(e);
    }
    const id = e.tool_use_id;
    const how = mode;
    await log($, 'call.start', {
      id,
      mode: how,
      keys: Object.keys(e),
      runInBackground: e.run_in_background ?? null,
      remainingMs: next.budget?.remainingMs ?? null,
    });
    const began = Date.now();
    const result = await next(e);
    const nextMs = Date.now() - began;
    const left = next.budget?.remainingMs ?? null;
    await log($, 'call.next', { id, mode: how, nextMs, remainingMs: left, ...resultFacts(result) });
    if (how === 'spin') {
      const end = Date.now() + SPIN_MS;
      while (Date.now() < end) {
        // §8.3: a hook that never yields; the heartbeat replaces the worker after 5 s.
      }
      await log($, 'spin.end', { id });
      return { ...result, context: [codeWord(SPIN_HOOK_MARKER)] };
    }
    let ended = 'slept';
    try {
      await $.clock.sleep(HOLD_MS, { signal: next.signal });
    } catch (error) {
      ended = `rejected: ${error?.name}: ${error?.message}`;
    }
    await log($, 'hold.end', {
      id,
      how: ended,
      heldMs: Date.now() - began - nextMs,
      remainingMs: next.budget?.remainingMs ?? null,
      aborted: next.signal?.aborted ?? null,
      reason: reasonOf(next.signal),
    });
    return { ...result, context: [codeWord(HOLD_MARKER)] };
  }).catch(async ($, e, next) => {
    await log($, 'catch', {
      id: e.tool_use_id ?? null,
      tool: e.tool,
      called: next.called ?? null,
      error: String(next.error?.message ?? next.error ?? '').slice(0, 200),
    });
    if (!isMainAgentCall(e)) {
      return next(e);
    }
    const result = await next(e);
    await log($, 'catch.answer', { id: e.tool_use_id ?? null, ...resultFacts(result) });
    return { ...result, context: [codeWord(CATCH_MARKER)] };
  });
};
