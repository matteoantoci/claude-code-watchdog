// Release-probe mod for the TUI scenario (spec §16.5 UI and queue order items):
// - two AbovePrompt cards whose Buttons share the bare digit hotkey 2 (research/you-should-know.md:135);
// - the prompt typed during a reply: its prompt.submit fields, and one context line (smoke-aside-nudge.md:398);
// - `/rdprobe fork`: the /cost ledger around one $.model.fork, the route You should know uses, and around one
//   $.model.complete (research/you-should-know.md:61,136; research/model-calls.md:20);
// - `/rdprobe note`: one $.ui.log row in the watchdog's row format (§13.2), for the ctrl+o view
//   (issues/11-ui-prototype.md:37).
const FILE = '__LOG__/rd-band.jsonl';
const QUEUED_MARK = 'QUEUED=PAPA';
const QUEUED_CONTEXT = 'RDCTX-QUEUED: a probe marker line; ignore it.';
const NOTE_ROW = '[concern] rdprobe: RDNOTE-CTRLO a row in the watchdog row format (steered)';
const FORK_PROMPT = 'Reply with exactly FORKED.';
const COMPLETE_PROMPT = 'Reply with exactly COMPLETED.';
const COMMAND = { name: 'rdprobe', description: 'watchdog live probe', argumentHint: 'fork|note', immediate: true };
const CALL_TIMEOUT_MS = 60_000;
const SETTLE_MS = 300;
// §13.2: a row from a command.run hook waits 300 ms, so it lands below the command echo.
const ROW_DELAY_MS = 300;
const lines = [];
let writing = null;
let isDirty = false;

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

const record = ($, data) => {
  lines.push(JSON.stringify({ t: Date.now(), ...data }));
  return flush($);
};

const errorText = (error) => String(error?.message ?? error).slice(0, 180);

// §16.5 UI: which card's Button the digit pressed; the press runs the closure of the render that drew it.
const press = ($, which) => {
  void record($, { kind: 'press', which });
  void Promise.resolve($.ui.log(`RDCARD press ${which}`)).catch(() => undefined);
};

// What /cost totals: `$.session.usage()` `cost.usd`, "what the session has cost so far, as /cost totals it" (d.ts).
const ledger = async ($) => {
  try {
    return (await $.session.usage())?.cost?.usd ?? null;
  } catch {
    return null;
  }
};

// One model call, bounded by the clock (a fork takes no timeout of its own), as plain data.
const settle = async (call) => {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ isAnswered: false, reason: 'probe timeout' }), CALL_TIMEOUT_MS);
    });
    const result = await Promise.race([call(), timeout]);
    return {
      isAnswered: result?.isAnswered ?? false,
      reason: result?.reason ?? null,
      text: String(result?.text ?? '').slice(0, 80),
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return { isAnswered: false, reason: `throw ${errorText(error)}`, text: '', usage: null };
  } finally {
    clearTimeout(timer);
  }
};

// §16.5 UI: the ledger before and after one fork, then after one completion, with no model turn between them.
const measure = async ($) => {
  const before = await ledger($);
  const fork = await settle(() => $.model.fork({ prompt: FORK_PROMPT }));
  await $.clock.sleep(SETTLE_MS);
  const afterFork = await ledger($);
  const complete = await settle(() =>
    $.model.complete({ model: 'haiku', prompt: COMPLETE_PROMPT, maxTokens: 16, timeoutMs: CALL_TIMEOUT_MS })
  );
  await $.clock.sleep(SETTLE_MS);
  const afterComplete = await ledger($);
  return { before, afterFork, afterComplete, fork, complete };
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register(COMMAND);
      await record($, { kind: 'command', outcome: 'ok' });
    } catch (error) {
      await record($, { kind: 'command', outcome: `throw ${errorText(error)}` });
    }
    return next(e);
  });
  on('command.run', { command: 'rdprobe' }, async ($, e) => {
    const args = String(e.args ?? '').trim();
    if (args === 'fork') {
      const result = await measure($);
      await record($, { kind: 'fork', ...result });
      return { text: `RDFORK ledger ${result.before} -> ${result.afterFork} -> ${result.afterComplete}` };
    }
    if (args === 'note') {
      $.clock.after(ROW_DELAY_MS, () => {
        $.ui.log(NOTE_ROW);
      });
      await record($, { kind: 'note' });
      return { text: 'RDNOTE row sent' };
    }
    return { text: 'usage: /rdprobe fork|note' };
  });
  // research/you-should-know.md:135: two cards, each with a plain Button on hotkey 2; the later one in the tree is
  // the second card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey) {
      return next(e);
    }
    const base = await next(e);
    const E = $.ui.resolve(e);
    const card = (key, title, which) =>
      E.Box({
        key,
        flexDirection: 'column',
        children: [
          E.Text({ children: title }),
          E.Button({ key: `${key}-btn`, label: which, hotkey: '2', plain: true, onPress: () => press($, which) }),
        ],
      });
    return E.Box({
      key: 'rd-band',
      flexDirection: 'column',
      children: [base, card('rd-card-1', 'RDCARD-A', 'first'), card('rd-card-2', 'RDCARD-B', 'second')],
    });
  });
  // smoke-aside-nudge.md:398: the prompt typed during the last reply; the plugin's aside rides on such a prompt as
  // a context line (§10.2), so this one carries one too.
  on('prompt.submit', async ($, e, next) => {
    if (!String(e.text ?? '').includes(QUEUED_MARK)) {
      return next(e);
    }
    await record($, { kind: 'submit', turnId: e.turnId ?? null, wait: e.wait ?? null, origin: e.origin?.kind ?? null });
    return next({ ...e, context: [...(e.context ?? []), QUEUED_CONTEXT] });
  });
};
