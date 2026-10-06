// First check 5 (spec §16.4), adapted from prototypes/first-checks/submit-rows (a TUI session). Three
// `$.prompt.submit` calls of this mod, one per main `turn.complete`:
// 1. yield: the hook submits, then awaits a `$` call (yields to the host) before it returns: the own hook should run;
// 2. none: the hook submits and returns at once, with no `$` call: the own hook rarely runs;
// 3. clock: a `$.clock.after` callback submits 2 s after the turn, while the session is idle (the §10.3 nudge
//    route): the own hook should not run.
// The plugin depends on none of these (§10.3), so the check is advisory. Log lines stay in memory and are written
// by the other hooks, because a write is a `$` call that would turn variant 2 into variant 1.
const FILE = '__LOG__/fc-submit.jsonl';
const MARKS = { yield: 'FCYIELD-PONG', none: 'FCNONE-PONG', clock: 'FCCLOCK-PONG' };
const CLOCK_MS = 2000;
const lines = [];
let writing = null;
let completes = 0;

const rec = (ev, data = {}) => {
  lines.push(JSON.stringify({ t: Date.now(), ev, ...data }));
};

const flush = ($) => {
  const text = `${lines.join('\n')}\n`;
  writing = (writing ?? Promise.resolve()).then(() => $.fs.write(FILE, text)).catch(() => undefined);
  return writing;
};

// The variant whose marker a prompt text holds, or null for the person's prompt.
const variantOf = (text) => Object.keys(MARKS).find((key) => String(text ?? '').includes(MARKS[key])) ?? null;

const submitText = (variant) => `${MARKS[variant]} Reply with exactly one word: PONG`;

// Submits without awaiting, so the calling hook decides whether it yields.
const submit = ($, variant) => {
  rec('submit', { variant });
  $.prompt.submit({ text: submitText(variant) }).then(
    () => rec('submit.resolved', { variant }),
    (error) => rec('submit.rejected', { variant, error: String(error?.message ?? error) })
  );
};

export const register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    const text = String(e.text ?? '').slice(0, 80);
    rec('own.submit', { variant: variantOf(e.text), origin: e.origin ?? null, text });
    await flush($);
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      rec('turn.start', { variant: variantOf(e.text), text: String(e.text ?? '').slice(0, 80) });
      await flush($);
    }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (e.agentId || e.isAborted) {
      return next(e);
    }
    completes += 1;
    rec('complete', { n: completes, answer: String(e.answer ?? '').slice(0, 40) });
    if (completes === 1) {
      submit($, 'yield');
      await $.clock.now();
      rec('yielded');
      return next(e);
    }
    if (completes === 2) {
      submit($, 'none');
      return next(e);
    }
    if (completes === 3) {
      $.clock.after(CLOCK_MS, async () => {
        rec('clock.fire');
        try {
          await $.prompt.submit({ text: submitText('clock') });
          rec('submit.resolved', { variant: 'clock' });
        } catch (error) {
          rec('submit.rejected', { variant: 'clock', error: String(error?.message ?? error) });
        }
        await flush($);
      });
    }
    await flush($);
    return next(e);
  });
};
