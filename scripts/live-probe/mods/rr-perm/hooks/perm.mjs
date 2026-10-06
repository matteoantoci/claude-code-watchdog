// §16.5 roster and tools (research/smoke-mutating-tools.md Q3, Q4 and Gaps). installMod fills __LOG__ and __TOOLS__
// (`yes` in one session only). At the first main turn.complete it spawns:
// - `editor` (tools Read, Edit, Write; permissionMode dontAsk): an Edit of math.js, then a Write of rr-wrote.txt. With
//   a `default` parent the agent's dontAsk denies both; an acceptEdits-like parent (bypassPermissions, auto) wins
//   over the agent's mode, so both run. Its tool.check verdicts and tool.call results are recorded.
// - with __TOOLS__ = yes, `listed` (tools Read, Glob; no disallowedTools) and `denied` (tools Read, Glob, Bash,
//   Edit, Write; disallowedTools Bash, Edit, Write). Their system prompts carry RRTOOLS-LISTED and RRTOOLS-DENIED,
//   so the proxy's saved request bodies show each one's tool list.
// Result: __LOG__/rr-perm.json.
const FILE = '__LOG__/rr-perm.json';
const PLUGIN = 'rrperm';
const TOOLS = '__TOOLS__' === 'yes';
const EDITED = new Set(['Edit', 'Write']);

const state = { phase: 'idle', checks: [], calls: [], spawns: {} };
let writing = Promise.resolve();

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 800) });

const write = ($) => {
  writing = writing.then(() => $.fs.write(FILE, JSON.stringify(state))).catch(() => undefined);
  return writing;
};

// The Read first: Edit refuses a file it has not read before its permission check runs, and that is not this probe.
const EDIT_TASK =
  'Do these three tool calls, in this order. Do not retry a refusal. ' +
  '1. Read math.js. ' +
  '2. Edit math.js: replace the first line `export function add(a, b) {` with ' +
  '`export function add(a, b) { // RRPERM`. ' +
  '3. Write the file rr-wrote.txt with the contents hi. ' +
  'Then reply DONE.';

const AGENTS = [
  {
    name: 'editor',
    description: 'Permission probe agent. The probe spawns it; do not delegate to it.',
    prompt: 'Follow the task. Do not retry a refused tool.',
    tools: ['Read', 'Edit', 'Write'],
    permissionMode: 'dontAsk',
    maxTurns: 6,
  },
  {
    name: 'listed',
    description: 'Tool-list probe agent. The probe spawns it; do not delegate to it.',
    prompt: 'RRTOOLS-LISTED. Reply with exactly OK. Do not call tools.',
    tools: ['Read', 'Glob'],
    maxTurns: 1,
  },
  {
    name: 'denied',
    description: 'Tool-list probe agent. The probe spawns it; do not delegate to it.',
    prompt: 'RRTOOLS-DENIED. Reply with exactly OK. Do not call tools.',
    tools: ['Read', 'Glob', 'Bash', 'Edit', 'Write'],
    disallowedTools: ['Bash', 'Edit', 'Write'],
    maxTurns: 1,
  },
];

const spawn = async ($, name, prompt) => {
  try {
    const resolved = await $.agent.spawn({ subagentType: `${PLUGIN}:${name}`, description: `probe ${name}`, prompt });
    return { agentId: resolved?.agentId ?? null, resolved };
  } catch (err) {
    return { agentId: null, rejected: errOf(err) };
  }
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    for (const agent of TOOLS ? AGENTS : AGENTS.slice(0, 1)) {
      try {
        await $.agent.register({ ...agent, model: 'haiku', omitClaudeMd: true, background: true });
      } catch (err) {
        state.registerError = errOf(err);
      }
    }
    return next(e);
  });

  on('agent.offer', async ($, e, next) =>
    String(e.agent ?? '').startsWith(`${PLUGIN}:`) ? { isOffered: false } : next(e)
  );

  // The engine's verdict for the editor's Edit and Write (a bypassPermissions parent may ask no question at all).
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId && EDITED.has(e.tool)) {
      state.checks.push({
        tool: e.tool,
        agentId: e.agentId,
        decision: result?.decision ?? null,
        reason: String(result?.reason ?? '').slice(0, 300),
      });
      await write($);
    }
    return result;
  });

  // What the editor's Edit and Write answered.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId && EDITED.has(e.tool)) {
      state.calls.push({
        tool: e.tool,
        agentId: e.agentId,
        isError: result?.isError === true || result?.deny !== undefined,
        text: String(result?.text ?? result?.deny ?? '').slice(0, 300),
      });
      await write($);
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && state.phase === 'idle') {
      state.phase = 'spawning';
      state.spawns.editor = await spawn($, 'editor', EDIT_TASK);
      if (TOOLS) {
        state.spawns.listed = await spawn($, 'listed', 'Reply with exactly OK.');
        state.spawns.denied = await spawn($, 'denied', 'Reply with exactly OK.');
      }
      state.phase = 'spawned';
      await write($);
    } else if (e.agentId && e.agentId === state.spawns.editor?.agentId) {
      state.editorEnd = { reason: e.reason ?? null, answer: String(e.answer ?? '').slice(0, 400) };
      state.phase = 'done';
      await write($);
    }
    return result;
  });
};
