// First checks 7 and 8 (spec §16.4). Loaded after the watchdog, so `next(e)` of its `tool.check` hook is the engine
// verdict: it logs that verdict and whether the check carries `agentId`, and returns it unchanged, so the watchdog
// sees the engine `ask` and can deny. It also logs the keys of each main-loop response row (`session.append`), to
// show that no field links the rows of one response.
const FILE = '__LOG__/fc-scope.jsonl';
const lines = [];
let writing = null;

const log = ($, ev, data) => {
  lines.push(JSON.stringify({ t: Date.now(), ev, ...data }));
  const text = `${lines.join('\n')}\n`;
  writing = (writing ?? Promise.resolve()).then(() => $.fs.write(FILE, text)).catch(() => undefined);
  return writing;
};

const short = (value) => {
  const text = JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
};

export const register = (on) => {
  // §6.5: the engine verdict of a Read, Grep or Glob, before the watchdog changes it.
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    if (e.tool === 'Read' || e.tool === 'Grep' || e.tool === 'Glob') {
      await log($, 'engine', {
        tool: e.tool,
        agentId: e.agentId ?? null,
        hasAgentId: 'agentId' in e,
        keys: Object.keys(e),
        origin: next.origin ?? null,
        tool_use_id: e.tool_use_id ?? null,
        input: short(e.input ?? null),
        decision: result?.decision ?? null,
        reason: result?.reason ?? null,
      });
    }
    return result;
  });
  // §7.1: the fields of one response row and of its message.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.door === 'response') {
      const content = e.message?.content;
      await log($, 'row', {
        keys: Object.keys(e),
        messageKeys: Object.keys(e.message ?? {}),
        blocks: (Array.isArray(content) ? content : [content]).map((block) => block?.type ?? typeof block),
      });
    }
    return next(e);
  });
};
