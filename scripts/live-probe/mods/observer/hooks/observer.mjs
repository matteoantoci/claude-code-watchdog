// The probe's observer: a second plugin (`wdprobe`) loaded beside `plugins/watchdog`. It never changes an event:
// each hook logs what it sees and passes `e` and the result on unchanged. One JSON object for each line in
// __LOG__/observer-<instance>.jsonl (a hooks module cannot import node:fs, so it logs with `$.fs.write`; spec §16.3).
// Two plugins see the same agent events and the synthetic `tool.call` `Agent` of a spawn
// (research/spawn-sites.md, layout B).
const LOG_DIR = '__LOG__';
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const FILE = `${LOG_DIR}/observer-${INSTANCE}.jsonl`;
const SKIP =
  /^(fs|env|clock|store|state|ui\.render|ui\.mount|ui\.invalidate|engine|classic|telemetry)\b|^(command\.describe|tool\.describe|prompt\.attachment|agent\.list|session\.id|session\.messages|session\.usage|session\.measure|config\.list|config\.describe|command\.list)$/u;
const lines = [];
let writing = null;
let isDirty = false;
let listPoll = 0;

const short = (value, max = 600) => {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text !== undefined && text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
};

const flush = ($) => {
  if (writing) {
    isDirty = true;
    return writing;
  }
  writing = (async () => {
    do {
      isDirty = false;
      await $.fs.write(FILE, `${lines.join('\n')}\n`);
    } while (isDirty);
  })()
    .catch(() => undefined)
    .finally(() => {
      writing = null;
    });
  return writing;
};

const log = ($, ev, data) => {
  lines.push(JSON.stringify({ t: Date.now(), i: INSTANCE, ev, ...data }));
  return flush($);
};

const textOf = (content, max) => {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''))
    .join('\n')
    .slice(0, max);
};

const blockKinds = (content) =>
  (Array.isArray(content) ? content : [content]).map((block) =>
    typeof block === 'string'
      ? 'string'
      : block?.type === 'tool_use'
        ? `tool_use:${block.name}:${block.id}`
        : block?.type === 'tool_result'
          ? `tool_result:${block.tool_use_id}`
          : block?.type === 'thinking'
            ? `thinking:${String(block.thinking ?? '').length}`
            : String(block?.type)
  );

const snapList = async ($, why) => {
  try {
    const list = await $.agent.list();
    await log($, 'agent.list', { why, list });
    return list;
  } catch (error) {
    await log($, 'agent.list.error', { why, error: String(error?.message ?? error) });
    return [];
  }
};

// First check 2: the `spawnedBy` field shows tens of ms after the spawn resolves, so poll the list for 3 s after
// each spawn and log each change.
const pollList = ($, why) => {
  listPoll += 1;
  const mine = listPoll;
  let last = '';
  const started = Date.now();
  const tick = async () => {
    if (mine !== listPoll || Date.now() - started > 3000) {
      return;
    }
    try {
      const list = await $.agent.list();
      const text = JSON.stringify(list);
      if (text !== last) {
        last = text;
        await log($, 'agent.list.poll', { why, ms: Date.now() - started, list });
      }
    } catch {}
    setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
};

// §10.7: the notes the engine sends to the model, as the API view of the session shows them.
const noteMarks = async ($) => {
  try {
    const messages = await $.session.messages({ as: 'api' });
    const marks = [];
    messages.forEach((message, index) => {
      const text = JSON.stringify(message.content ?? message);
      if (text.includes('watchdog-notes')) {
        marks.push({ index, role: message.role, text: text.slice(0, 1500) });
      }
    });
    return { count: messages.length, marks };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

export const register = (on) => {
  on('*', async ($, e, next) => {
    const ev = next.event;
    if (!SKIP.test(ev)) {
      await log($, 'star', { event: ev, agentId: e?.agentId ?? null, origin: next.origin ?? null });
    }
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    await log($, 'session.start', { e: short(e, 800), sessionId: await $.session.id().catch(() => null) });
    return next(e);
  });
  on('session.attach', async ($, e, next) => {
    await log($, 'session.attach', { e: short(e, 800) });
    return next(e);
  });
  on('session.compact', async ($, e, next) => {
    const before = await $.session.id().catch(() => null);
    const result = await next(e);
    await log($, 'session.compact', { before, after: await $.session.id().catch(() => null) });
    return result;
  });
  on('session.end', async ($, e, next) => {
    await log($, 'session.end', { e: short(e, 800) });
    await flush($);
    return next(e);
  });
  on('command.run', async ($, e, next) => {
    const before = await $.session.id().catch(() => null);
    await log($, 'command.run.in', { command: e.command, args: e.args, origin: e.origin ?? null, sessionId: before });
    const result = await next(e);
    await log($, 'command.run.out', {
      command: e.command,
      args: e.args,
      text: short(result?.text ?? null, 3000),
      sessionId: await $.session.id().catch(() => null),
    });
    return result;
  });
  on('agent.register', async ($, e, next) => {
    const result = await next(e).catch(async (error) => {
      await log($, 'agent.register.error', { name: e.name, error: String(error?.message ?? error) });
      throw error;
    });
    await log($, 'agent.register', {
      name: e.name,
      model: e.model,
      effort: e.effort,
      tools: e.tools,
      maxTurns: e.maxTurns,
      origin: next.origin ?? null,
      result: short(result, 300),
    });
    return result;
  });
  on('agent.spawn', async ($, e, next) => {
    await log($, 'agent.spawn.in', {
      subagentType: e.subagentType,
      model: e.model ?? null,
      background: e.background ?? null,
      tool_use_id: e.tool_use_id ?? null,
      parentAgentId: e.parentAgentId ?? null,
      isTeammate: e.isTeammate ?? null,
      origin: next.origin ?? null,
      prompt: short(e.prompt ?? '', 4000),
    });
    const result = await next(e);
    await log($, 'agent.spawn.out', { subagentType: e.subagentType, result });
    pollList($, `spawn ${result?.agentId ?? '?'}`);
    return result;
  });
  on('tool.call', async ($, e, next) => {
    const { tool, agentId, tool_use_id: toolUseId, ...input } = e;
    await log($, 'tool.call.in', {
      tool,
      agentId: agentId ?? null,
      tool_use_id: toolUseId ?? null,
      keys: Object.keys(e),
      origin: next.origin ?? null,
      input: short(input, 1500),
    });
    const result = await next(e);
    await log($, 'tool.call.out', {
      tool,
      agentId: agentId ?? null,
      tool_use_id: toolUseId ?? null,
      result: short(result, 1500),
    });
    return result;
  });
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    await log($, 'tool.check', {
      tool: e.tool,
      agentId: e.agentId ?? null,
      tool_use_id: e.tool_use_id ?? null,
      origin: next.origin ?? null,
      ceiling: e.ceiling ?? null,
      input: short({ ...e, tool: undefined, agentId: undefined }, 600),
      result: short(result, 600),
    });
    return result;
  });
  on('session.append', async ($, e, next) => {
    const message = e.message ?? {};
    await log($, 'session.append', {
      agentId: e.agentId ?? null,
      door: e.door ?? null,
      origin: e.origin ?? null,
      uuid: e.uuid ?? null,
      type: message.type ?? null,
      blocks: blockKinds(message.content),
      text: textOf(message.content, 2000),
    });
    return next(e);
  });
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    await log($, 'ui.render.CommandOutput', {
      command: e.props?.command ?? null,
      args: e.props?.args ?? null,
      isErrored: e.props?.isErrored ?? null,
      requestId: e.requestId ?? null,
      text: short(e.props?.text ?? null, 600),
    });
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    await log($, 'prompt.submit', {
      text: short(e.text ?? '', 600),
      origin: e.origin ?? null,
      agentId: e.agentId ?? null,
      context: (e.context ?? []).map((item) => short(item, 600)),
    });
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    await log($, 'turn.start', {
      agentId: e.agentId ?? null,
      turnId: e.turnId ?? null,
      text: short(e.text ?? '', 400),
    });
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    await log($, 'turn.step', {
      agentId: e.agentId ?? null,
      index: e.index,
      model: e.model ?? null,
      messageCount: e.messageCount ?? null,
    });
    return yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    const isMain = !e.agentId;
    await log($, 'turn.complete', {
      agentId: e.agentId ?? null,
      turnId: e.turnId ?? null,
      reason: e.reason ?? null,
      isAborted: e.isAborted ?? null,
      answer: short(e.answer ?? '', 600),
      usage: e.usage ?? null,
      ...(isMain
        ? { sessionId: await $.session.id().catch(() => null), notes: await noteMarks($) }
        : { agentType: e.agentType ?? null }),
    });
    if (isMain) {
      await snapList($, 'main turn.complete');
    }
    return result;
  });
  on('ui.log', async ($, e, next) => {
    await log($, 'ui.log', { text: short(e.text ?? e, 2000), origin: next.origin ?? null });
    return next(e);
  });
  on('config.set', async ($, e, next) => {
    await log($, 'config.set', { e: short(e, 600), origin: next.origin ?? null });
    return next(e);
  });
};
