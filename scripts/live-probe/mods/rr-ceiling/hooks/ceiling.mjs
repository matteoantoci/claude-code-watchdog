// §16.5 read scope (spec §6.5): a tool.check `ceiling` that an org sets. d.ts ToolCheckInput.ceiling: "the most
// permissive verdict the organization lets a call of the tool reach, as its administrators set it on a connector's
// tool", set by the engine, never by a query. Run only with `--with org:ceiling`. installMod fills __LOG__.
// At the main turn.complete of a prompt that carries RRCEIL, a sweep asks $.tool.check for every tool of
// $.tool.list() (empty input; nothing runs, no dialog opens) and keeps each verdict's `ceiling`. Then, for each
// tool with a ceiling, it asks again while this plugin's tool.check hook answers `allow`: whether the ceiling caps
// a hook's allow, as the watchdog's §6.5 hook gives one. Two sweeps, so connector tools that connect late count.
// Result: __LOG__/rr-ceiling.json.
const FILE = '__LOG__/rr-ceiling.json';
const MARKER = 'RRCEIL';
const MAX_TOOLS = 200;

const state = { sweeps: [], forced: [], hookSaw: [] };
let lastText = '';
let forceAllow = null;

const errOf = (err) => ({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 400) });

const verdictOf = (verdict) => ({
  decision: verdict?.decision ?? null,
  ceiling: verdict?.ceiling ?? null,
  rule: verdict?.rule ?? null,
  reason: String(verdict?.reason ?? '').slice(0, 200),
});

const ask = async ($, tool) => {
  try {
    return verdictOf(await $.tool.check({ tool, input: {} }));
  } catch (err) {
    return { error: errOf(err).message };
  }
};

const sweep = async ($) => {
  let tools;
  try {
    tools = await $.tool.list();
  } catch (err) {
    state.sweeps.push({ listError: errOf(err) });
    return;
  }
  const rows = [];
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    rows.push({ tool: tool.name, mcp: tool.mcp === true, ...(await ask($, tool.name)) });
  }
  state.sweeps.push({ count: tools.length, rows });
  for (const row of rows.filter((item) => item.ceiling)) {
    if (!state.forced.some((item) => item.tool === row.tool)) {
      forceAllow = row.tool;
      state.forced.push({ tool: row.tool, ceiling: row.ceiling, before: row.decision, ...(await ask($, row.tool)) });
      forceAllow = null;
    }
  }
};

export const register = (on) => {
  // Answers `allow` for the one tool under test, as the watchdog's §6.5 hook turns an `ask` into an `allow`.
  on('tool.check', async ($, e, next) => {
    const result = await next(e);
    if (forceAllow !== null && e.tool === forceAllow) {
      state.hookSaw.push({ tool: e.tool, ceiling: e.ceiling ?? null, beneath: verdictOf(result) });
      return { decision: 'allow', reason: 'rrceiling probe: a hook allow' };
    }
    return result;
  });

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      lastText = String(e.text ?? '');
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && lastText.includes(MARKER)) {
      lastText = '';
      await sweep($);
      await $.fs.write(FILE, JSON.stringify(state)).catch(() => undefined);
    }
    return result;
  });
};
