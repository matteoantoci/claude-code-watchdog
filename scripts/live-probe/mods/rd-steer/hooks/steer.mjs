// Release-probe mod (spec §16.5 note wrapper and delivery text, cache cost of an append): while the first main
// reply streams, it appends one `<watchdog-notes>` note as the plugin's steer appends it (§10.1, §10.7), and it logs
// each main step's chunk counts and usage. The scenario writes the wrapped note to __DIR__/rd-steer-note.txt.
const FILE = '__LOG__/rd-steer.jsonl';
const NOTE_FILE = '__DIR__/rd-steer-note.txt';
// research/smoke-steer.md Q1: a timer append a moment after the first text chunk lands while the reply streams.
const APPEND_DELAY_MS = 200;
const lines = [];
let writing = null;
let isDirty = false;
let note = null;
let isScheduled = false;

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

// §10.1: the steer's own call (plugins/watchdog/hooks/delivery/install.ts); a `{ deny }` or a throw is the outcome.
// `calledAt` is when the call went out, so the check can tell it from the end of the reply's stream.
const appendNote = async ($, at) => {
  const calledAt = Date.now();
  let outcome = 'ok';
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } });
    outcome = appended && typeof appended === 'object' && 'deny' in appended ? `deny ${appended.deny}` : 'ok';
  } catch (error) {
    outcome = `throw ${errorText(error)}`;
  }
  await record($, { kind: 'append', outcome, calledAt, ...at });
};

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    note = await $.fs.read(NOTE_FILE).catch(() => null);
    await record($, { kind: 'start', hasNote: typeof note === 'string' && note.length > 0 });
    return next(e);
  });
  // §16.5: the first text chunk of the main loop schedules the append; every main step logs its usage, so the
  // check can compare the cache counts of the request before and after the append.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      return yield* next(e);
    }
    const counts = { texts: 0, thoughts: 0 };
    const stream = next(e);
    let result;
    for (;;) {
      const step = await stream.next();
      if (step.done) {
        result = step.value;
        break;
      }
      const chunk = step.value;
      counts.texts += chunk?.kind === 'text' ? 1 : 0;
      counts.thoughts += chunk?.kind === 'thinking' ? 1 : 0;
      if (chunk?.kind === 'text' && !isScheduled && note) {
        isScheduled = true;
        const at = { turnId: e.turnId, index: e.index, ...counts };
        try {
          $.clock.after(APPEND_DELAY_MS, () => appendNote($, at));
        } catch (error) {
          await record($, { kind: 'append', outcome: `schedule throw ${errorText(error)}`, ...at });
        }
      }
      yield chunk;
    }
    await record($, {
      kind: 'step',
      turnId: e.turnId,
      index: e.index,
      ...counts,
      stopReason: result?.stopReason ?? null,
      usage: result?.usage ?? null,
    });
    return result;
  });
};
