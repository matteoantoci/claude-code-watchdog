// An interactive probe session in tmux, on a private tmux server (socket `wdprobe-<pid>`), so no other tmux
// session is touched. The pane is captured to text; the session is answered with keys.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probeEnv, shellQuote, sleep } from './env.mjs';
import { pluginDirs, sessionArgs } from './headless.mjs';

export const TMUX_SOCKET = `wdprobe-${process.pid}`;

const tmux = (...args) =>
  execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The `env` line of the tmux command: the probe environment as a diff against this process's environment.
const envCommand = (extra) => {
  const target = probeEnv(extra);
  const unset = Object.keys(process.env).filter((name) => !(name in target));
  const set = Object.entries(target).filter(([name, value]) => process.env[name] !== value);
  return [
    'env',
    ...unset.flatMap((name) => ['-u', name]),
    ...set.map(([name, value]) => shellQuote(`${name}=${value}`)),
  ].join(' ');
};

// The prompt footer: `? for shortcuts`, `/tasks to see subagents` while a background agent (a review) runs, and
// `← for agents`, the only hint left when the user settings set a `statusLine`.
export const READY = /for shortcuts|to see subagents|← for agents/u;
export const BUSY = /esc to interrupt/iu;
const TRUST = /Yes, I trust this folder/u;

// Starts claude in run.proj and answers the trust dialog. Returns the driver.
export const startTui = async (run, options = {}) => {
  const {
    label = 'tui',
    plugins = pluginDirs(run),
    env = {},
    args = [],
    model = 'haiku',
    settingSources,
    width = 160,
    height = 50,
    startTimeoutMs = 60_000,
  } = options;
  const session = `${run.name}-${label}`.replaceAll(/[^A-Za-z0-9_-]/gu, '-');
  const argv = [...sessionArgs(run, { plugins, model, settingSources, label }), ...args];
  const errFile = path.join(run.logs, `${label}.err`);
  const command = `${envCommand(env)} ${shellQuote(run.ctx.bin)} ${argv.map(shellQuote).join(' ')} 2> ${shellQuote(errFile)}; echo CLAUDE_EXITED=$?; sleep 900`;
  fs.writeFileSync(path.join(run.logs, `${label}.argv.json`), JSON.stringify({ bin: run.ctx.bin, argv, env }, null, 2));
  try {
    tmux('kill-session', '-t', session);
  } catch {}
  tmux('new-session', '-d', '-s', session, '-x', String(width), '-y', String(height), '-c', run.proj, command);
  run.ctx.tmuxSessions.add(session);
  let seq = 0;
  const started = Date.now();
  const screen = ({ ansi = false } = {}) => {
    try {
      return tmux('capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', session);
    } catch {
      return '';
    }
  };
  const capture = (name, { ansi = false } = {}) => {
    seq += 1;
    const text = screen();
    const base = path.join(run.logs, `${label}-${String(seq).padStart(2, '0')}-${name}`);
    fs.writeFileSync(`${base}.txt`, text);
    if (ansi) {
      fs.writeFileSync(`${base}.ansi`, screen({ ansi: true }));
    }
    return text;
  };
  const keys = async (...names) => {
    for (const name of names) {
      tmux('send-keys', '-t', session, name);
      await sleep(250);
    }
  };
  // Types the text, waits, then presses Enter (a slash command needs the pause for its menu).
  const type = async (text, { enter = true } = {}) => {
    tmux('send-keys', '-t', session, '-l', text);
    await sleep(800);
    if (enter) {
      tmux('send-keys', '-t', session, 'Enter');
    }
    await sleep(300);
  };
  // Polls the pane until `test` (a regex or a function of the text) holds. Resolves { ok, text, ms }.
  const waitFor = async (test, { timeoutMs = 60_000, intervalMs = 1000 } = {}) => {
    const begin = Date.now();
    const holds = typeof test === 'function' ? test : (text) => test.test(text);
    for (;;) {
      const text = screen();
      if (holds(text)) {
        return { ok: true, text, ms: Date.now() - begin };
      }
      if (Date.now() - begin > timeoutMs) {
        return { ok: false, text, ms: Date.now() - begin };
      }
      await sleep(intervalMs);
    }
  };
  // Waits until the main turn no longer runs: two polls in a row without "esc to interrupt".
  const waitIdle = async ({ timeoutMs = 180_000, intervalMs = 1500 } = {}) => {
    let quiet = 0;
    return waitFor(
      (text) => {
        quiet = BUSY.test(text) || !READY.test(text) ? 0 : quiet + 1;
        return quiet >= 2;
      },
      { timeoutMs, intervalMs }
    );
  };
  const stop = async () => {
    capture('end', { ansi: true });
    try {
      tmux('send-keys', '-t', session, 'C-c');
      await sleep(400);
      tmux('send-keys', '-t', session, 'C-c');
      await sleep(1500);
      tmux('kill-session', '-t', session);
    } catch {}
    run.ctx.tmuxSessions.delete(session);
  };
  await waitFor((text) => TRUST.test(text) || READY.test(text) || /CLAUDE_EXITED/u.test(text), {
    timeoutMs: startTimeoutMs,
  });
  capture('start');
  // The trust dialog can take keys a moment after it is drawn, and Enter on its default "No, exit" ends claude:
  // press Enter only once the screen shows "Yes, I trust this folder" selected.
  for (let tries = 0; TRUST.test(screen()) && tries < 20; tries += 1) {
    if (/❯\s*Yes, I trust this folder/u.test(screen())) {
      await keys('Enter');
      break;
    }
    await keys('Down');
    await sleep(500);
  }
  const ready = await waitFor(READY, { timeoutMs: startTimeoutMs });
  capture('ready');
  if (!ready.ok) {
    await stop();
    throw new Error(
      `the TUI did not start in ${startTimeoutMs} ms: ${ready.text.trim().split('\n').slice(-8).join(' | ')}`
    );
  }
  return {
    session,
    label,
    started,
    screen,
    capture,
    keys,
    type,
    waitFor,
    waitIdle,
    stop,
    debugFile: path.join(run.logs, `${label}.debug`),
  };
};

// A permission dialog on screen. The regex skips the banner "Prompt from the watchdog plugin" that the TUI shows
// above a `$.prompt.submit` prompt (prototypes/first-checks/read-outside/tui.sh).
export const DIALOG = /Do you want to|Esc to cancel/u;

// While `until()` resolves false, each permission dialog on screen gets `answer` (a tmux key; null leaves it
// open). Resolves the dialogs seen, each with its time and screen.
export const watchDialogs = async (tui, { answer = 'Enter', until, timeoutMs = 120_000, intervalMs = 2000 }) => {
  const dialogs = [];
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs && !(await until())) {
    const text = tui.screen();
    if (DIALOG.test(text)) {
      dialogs.push({ ms: Date.now() - begin, text });
      tui.capture(`dialog-${dialogs.length}`);
      if (answer) {
        await tui.keys(answer);
      }
    }
    await sleep(intervalMs);
  }
  return dialogs;
};

export const killTmuxServer = () => {
  try {
    tmux('kill-server');
  } catch {}
};
