// First check 11 (spec §16.4, §14.6), adapted from prototypes/first-checks/reload. `/fcreload arm` sets a module
// variable, a `$.state` value and a `$.store` value, and starts a `$.clock.after` timer and a `$.clock.every` timer.
// The probe then edits this plugin's `userConfig` in ~/.claude/settings.json, which reloads the module. The new
// instance logs at `session.start` what it finds (the options, the module variable, the state and the store), starts
// a control timer, and deletes the store key. Each instance logs to its own file `fc-reload-<instance>.jsonl`, so two
// instances never overwrite each other.
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const FILE = `__LOG__/fc-reload-${INSTANCE}.jsonl`;
// A key of this run only: `$.store` is kept between sessions.
const STORE_KEY = '__STOREKEY__';
const STATE = { plugin: 'fcreload', key: 'mark' };
const AFTER_MS = 12_000;
const EVERY_MS = 500;
const MAX_TICKS = 60;
const CONTROL_MS = 3000;
const lines = [];
let writing = null;
let counter = 0;
let options = null;

const log = ($, ev, data = {}) => {
  lines.push(JSON.stringify({ t: Date.now(), inst: INSTANCE, ev, ...data }));
  const text = `${lines.join('\n')}\n`;
  writing = (writing ?? Promise.resolve()).then(() => $.fs.write(FILE, text)).catch(() => undefined);
  return writing;
};

const errorText = (error) => String(error?.message ?? error);

export const register = (on, given) => {
  options = given ?? null;
  // §14.6: at load, read what survived; a reloaded instance finds the state the old one set.
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    const state = await $.state.get(STATE).then(
      (read) => ({ value: read.value ?? null, version: read.version }),
      (error) => ({ error: errorText(error) })
    );
    const store = await $.store.get(STORE_KEY).then(
      (value) => ({ value: value ?? null }),
      (error) => ({ error: errorText(error) })
    );
    await log($, 'start', { options, counter, state, store, hasSource: 'source' in (e ?? {}) });
    await $.command
      .register({ name: 'fcreload', description: 'first-check 11 reload probe: arm', immediate: true })
      .catch((error) => log($, 'command.error', { error: errorText(error) }));
    if (state.value) {
      // §14.6: a timer the new instance sets fires.
      $.clock.after(CONTROL_MS, () => {
        log($, 'control.fire');
      });
      await $.store.delete(STORE_KEY).catch(() => undefined);
    }
    return result;
  });
  on('command.run', { command: 'fcreload' }, async ($) => {
    counter = 7;
    await $.state.set(STATE, { inst: INSTANCE, at: Date.now() });
    await $.store.set(STORE_KEY, { inst: INSTANCE });
    $.clock.after(AFTER_MS, () => {
      log($, 'after.fire');
    });
    let ticks = 0;
    const every = $.clock.every(EVERY_MS, () => {
      ticks += 1;
      log($, 'every.tick', { ticks });
      if (ticks >= MAX_TICKS) {
        every.cancel();
      }
    });
    await log($, 'armed', { counter, afterMs: AFTER_MS, everyMs: EVERY_MS });
    return { text: `fcreload armed ${INSTANCE}` };
  });
};
