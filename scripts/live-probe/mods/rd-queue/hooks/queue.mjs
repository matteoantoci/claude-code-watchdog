// Release-probe mod (spec §16.5 queue order and time; research/smoke-aside-nudge.md:267, case Q3d): the main
// turn.complete of the turn whose prompt holds RDHOLD waits HOLD_MS before next(e). Its prompt.submit, turn.start
// and turn.step hooks log when they run, so the next turn's dispatches can be timed against that hold.
const FILE = '__LOG__/rd-queue.jsonl';
const MARK = 'RDHOLD';
// Under the 10 s hook budget: a $.clock.sleep is the hook's own time (d.ts HookBudget).
const HOLD_MS = 6000;
const lines = [];
let writing = null;
let isDirty = false;
let holdTurn = null;
let isHeld = false;

// Rewrites the whole log file; a write asked while one runs is folded into one more pass (as the observer does).
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

// The time is taken when the hook runs, before any $ call of its own.
const record = ($, data) => {
  lines.push(JSON.stringify({ t: Date.now(), ...data }));
  return flush($);
};

export const register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    await record($, { kind: 'submit', text: String(e.text ?? '').slice(0, 120), turnId: e.turnId ?? null });
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    const text = String(e.text ?? '');
    if (holdTurn === null && text.includes(MARK)) {
      holdTurn = e.turnId;
    }
    await record($, { kind: 'start', turnId: e.turnId, text: text.slice(0, 120) });
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await record($, { kind: 'step', turnId: e.turnId, index: e.index });
    }
    return yield* next(e);
  });
  // smoke-aside-nudge.md Q3d: the hold sits before next(e), as `O_before_hold_CTX` held.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.turnId === holdTurn && !isHeld) {
      isHeld = true;
      await record($, { kind: 'hold-start', turnId: e.turnId });
      await $.clock.sleep(HOLD_MS);
      await record($, { kind: 'hold-end', turnId: e.turnId });
    }
    return next(e);
  });
};
