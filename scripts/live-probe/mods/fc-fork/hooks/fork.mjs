// First checks 3 and 6 (spec §16.4), from prototypes/first-checks/spawn-id and prototypes/first-checks/register.
// Item 3: a plugin agent that stays alive past 30 s (short Bash sleeps, one per response), so the TUI forks an
// [AgentSummary] agent (the debug file shows it) and -p does not; two `$.agent.list()` reads at +31 s and +34 s show
// whether the fork joins the list. Item 6: the events before `session.start`, a register at the first lifecycle event
// (command.describe, ui.render or session.start), what `register` gets at load (no `$`), and a register and a spawn
// in one `prompt.submit` handler.
const FILE = '__LOG__/fc-fork.jsonl';
const TYPE = 'fcfork:slow';
const SPEC = {
  name: 'slow',
  description: 'Slow probe agent for the summary-fork check.',
  prompt: 'You are a terse probe agent. Follow the task exactly. Do not summarize your progress.',
  tools: ['Bash'],
  model: 'haiku',
  effort: 'low',
  omitClaudeMd: true,
  background: true,
};
const SLOW =
  'Work slowly. One tool call per response, never parallel calls. Do 8 rounds. In each round run the Bash ' +
  'command "sleep 4" and nothing else. After round 8 reply DONE.';
// §4.5: the events the spec orders: the first TUI event is command.describe, the first -p event session.start.
const LIFECYCLE = new Set(['command.describe', 'ui.render', 'session.start']);
// §6.4: list reads after the 30 s fork time.
const LIST_AT_MS = [31_000, 34_000];
const lines = [];
const before = [];
let writing = null;
let isStarted = false;
let isFirstRegistered = false;
let isSessionStarted = false;

// Keeps a line in memory; `flush` writes them all (a hooks module cannot import node:fs, spec §16.3).
const rec = (ev, data = {}) => {
  lines.push(JSON.stringify({ t: Date.now(), ev, ...data }));
};

const flush = ($) => {
  const text = `${lines.join('\n')}\n`;
  writing = (writing ?? Promise.resolve()).then(() => $.fs.write(FILE, text)).catch(() => undefined);
  return writing;
};

const log = ($, ev, data) => {
  rec(ev, data);
  return flush($);
};

const errorText = (error) => String(error?.message ?? error);

// §6.4: the fork never shows in the list; each entry's `id` and `spawnedBy`.
const readList = async ($, atMs) => {
  const list = await $.agent.list().then(
    (value) => ({ entries: value.map((agent) => ({ id: agent.id, type: agent.type, spawnedBy: agent.spawnedBy })) }),
    (error) => ({ error: errorText(error) })
  );
  await log($, 'list', { atMs, ...list });
};

export const register = (on, ...rest) => {
  // §4.5 item 6: no `$` at load; `register` gets `on` and the plugin's options only.
  rec('load', {
    args: rest.map((arg) => (arg && typeof arg === 'object' ? Object.keys(arg) : typeof arg)),
    hasGlobalDollar: typeof globalThis.$ !== 'undefined',
  });
  on('*', async ($, e, next) => {
    const ev = next.event;
    if (ev === 'engine.create') {
      // §4.5 item 6: no `$` exists at load; a `$` call here throws (2.1.290: a TypeError).
      const call = await Promise.resolve()
        .then(() => $.session.id())
        .then(
          () => 'resolved',
          (error) => errorText(error)
        );
      rec('engine.create', { call });
      return next(e);
    }
    if (ev.startsWith('fs.')) {
      return next(e);
    }
    if (!isSessionStarted && !before.includes(ev)) {
      before.push(ev);
    }
    // §4.5 item 6: a register before the session binds does not reject; not awaited, so it cannot hold the event.
    if (!isFirstRegistered && LIFECYCLE.has(ev)) {
      isFirstRegistered = true;
      const began = Date.now();
      rec('first.register.call', { event: ev });
      $.agent.register(SPEC).then(
        (result) => rec('first.register.ok', { event: ev, ms: Date.now() - began, result }),
        (error) => rec('first.register.err', { event: ev, ms: Date.now() - began, error: errorText(error) })
      );
    }
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    isSessionStarted = true;
    // The `*` hook may run after this one for the same event.
    if (!before.includes('session.start')) {
      before.push('session.start');
    }
    rec('order', { events: before });
    const result = await $.agent.register(SPEC).then(
      (value) => ({ ok: true, value: value ?? null }),
      (error) => ({ ok: false, error: errorText(error) })
    );
    await log($, 'register', { where: 'session.start', ...result });
    return next(e);
  });
  on('agent.offer', { agent: TYPE }, async () => ({ isOffered: false }));
  on('prompt.submit', async ($, e, next) => {
    if (String(e.text ?? '').includes('WDGO') && !isStarted) {
      isStarted = true;
      // §5.2, §16.4 item 6: a register and a spawn in the same handler.
      const registered = await $.agent.register(SPEC).then(
        (value) => ({ ok: true, value: value ?? null }),
        (error) => ({ ok: false, error: errorText(error) })
      );
      const calledAt = Date.now();
      await log($, 'spawn.call', { type: TYPE, registered });
      $.agent.spawn({ subagentType: TYPE, description: 'summary fork probe', prompt: SLOW }).then(
        (result) => {
          LIST_AT_MS.forEach((ms) => {
            setTimeout(() => readList($, ms), Math.max(0, calledAt + ms - Date.now()));
          });
          return log($, 'spawn.resolved', { agentId: result?.agentId ?? null, ms: Date.now() - calledAt });
        },
        (error) => log($, 'spawn.rejected', { error: errorText(error) })
      );
    }
    await flush($);
    return next(e);
  });
};
