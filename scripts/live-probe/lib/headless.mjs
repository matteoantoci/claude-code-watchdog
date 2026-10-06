// A `claude -p` probe session with stream-json output (spec §16.3 setup). With `input`, the prompts go on stdin as
// stream-json user messages, so the session stays alive between them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR, SETTING_SOURCES, probeEnv, sleep } from './env.mjs';
import { installMod, readJsonLines } from './run.mjs';

// The plugin folders of a session: the observer (`wdprobe`) first when asked, then `plugins/watchdog` unless
// `watchdog: false`, then the probe mods of mods/ (each filled with the run folder).
export const pluginDirs = (run, { observer = true, watchdog = true, mods = [], fill = {} } = {}) => [
  ...(observer ? [installMod(run, 'observer', fill)] : []),
  ...(watchdog ? [PLUGIN_DIR] : []),
  ...mods.map((mod) => installMod(run, mod, fill)),
];

export const userMessage = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

export const sessionArgs = (run, { plugins, model = 'haiku', settingSources = SETTING_SOURCES, label }) => [
  ...plugins.flatMap((dir) => ['--plugin-dir', dir]),
  '--setting-sources',
  settingSources,
  ...(model ? ['--model', model] : []),
  '--debug-file',
  path.join(run.logs, `${label}.debug`),
];

const feed = async (child, input, closeAfterMs) => {
  const send = (text) => {
    if (child.exitCode === null) {
      child.stdin.write(`${userMessage(text)}\n`);
    }
  };
  if (typeof input === 'function') {
    await input(send, child);
  } else {
    for (const item of input) {
      const step = typeof item === 'string' ? { text: item } : item;
      await sleep(step.afterMs ?? 0);
      send(step.text);
    }
  }
  await sleep(closeAfterMs);
  child.stdin.end();
};

// Runs one `-p` session in run.proj. `prompt` is the -p argument; `input` sends stream-json user messages
// instead: a list (strings or { text, afterMs }), or `async (send, child) => {}` that calls send(text) when it
// likes. stdin closes `closeAfterMs` after the last message (or after the function resolves), which ends the
// session once its work is done. Resolves with the parsed stream.
export const runHeadless = async (run, options) => {
  const {
    label = 'p',
    prompt,
    input,
    closeAfterMs = 20_000,
    plugins = pluginDirs(run),
    env = {},
    args = [],
    model = 'haiku',
    settingSources = SETTING_SOURCES,
    timeoutMs = 300_000,
  } = options;
  const argv = [
    '-p',
    ...(input ? ['--input-format', 'stream-json'] : [prompt]),
    '--output-format',
    'stream-json',
    '--verbose',
    ...sessionArgs(run, { plugins, model, settingSources, label }),
    ...args,
  ];
  const stdoutFile = path.join(run.logs, `${label}.jsonl`);
  const stderrFile = path.join(run.logs, `${label}.err`);
  fs.writeFileSync(path.join(run.logs, `${label}.argv.json`), JSON.stringify({ bin: run.ctx.bin, argv, env }, null, 2));
  const started = Date.now();
  const child = spawn(run.ctx.bin, argv, { cwd: run.proj, env: probeEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(stdoutFile);
  const err = fs.createWriteStream(stderrFile);
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  let isTimedOut = false;
  const timer = setTimeout(() => {
    isTimedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, timeoutMs);
  if (input) {
    feed(child, input, closeAfterMs).catch(() => undefined);
  } else {
    child.stdin.end();
  }
  const [exitCode, signal] = await new Promise((resolve) => {
    child.on('close', (code, sig) => resolve([code, sig]));
  });
  clearTimeout(timer);
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
  const events = readJsonLines(stdoutFile);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init') ?? null;
  return {
    label,
    exitCode,
    signal,
    isTimedOut,
    wallMs: Date.now() - started,
    events,
    init,
    sessionId: init?.session_id ?? events.find((event) => event.session_id)?.session_id ?? null,
    result: events.findLast((event) => event.type === 'result') ?? null,
    stderr: fs.readFileSync(stderrFile, 'utf8'),
    stdoutFile,
    debugFile: path.join(run.logs, `${label}.debug`),
  };
};

// The assistant text blocks and tool_use blocks of a stream, in order.
export const assistantBlocks = (events) =>
  events
    .filter((event) => event.type === 'assistant' && !event.parent_tool_use_id)
    .flatMap((event) => event.message?.content ?? []);

export const assistantText = (events) =>
  assistantBlocks(events)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
