// The L3 column of spec §16.1 as live checks. Each row whose L3 cell is not `no` has one or more checks here, and
// `source` names the row. The shared scenarios (checks/shared.mjs) carry the facts one session can show; a row a
// shared session cannot show gets its own scenario here. Nothing here changes the plugin: a failing check is a fact
// to report.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_DIR, sleep } from '../lib/env.mjs';
import { collectDumps, dumpReviews, rowText, subagentTranscripts } from '../lib/files.mjs';
import { assistantText, runHeadless } from '../lib/headless.mjs';
import {
  agentTurnCompletes,
  mainTurnCompletes,
  noteCalls,
  ofEvent,
  readObs,
  waitObs,
  watchdogSpawns,
} from '../lib/observe.mjs';
import { createRun, readText } from '../lib/run.mjs';
import { BUSY, TMUX_SOCKET, startTui } from '../lib/tui.mjs';
import { clip, expectAll, fail, inconclusive, pass } from '../lib/verdict.mjs';
import { probeRoster, REVIEW_PROMPT } from './shared.mjs';

// ---------------------------------------------------------------- spec texts

// §14.4, §14.3: the feed lines that a rewind and a `/resume` or `/branch` put before the next update.
const REWIND_MARKER = '[user rewound the conversation]';
const REPLAY_MARKER = '[earlier history, before the watchdog started]';
// §10.3: the frame the engine puts before a plugin prompt; the model reads the nudge after it.
const NUDGE_FRAME = 'The watchdog plugin sent a message:';
// §12.2: the subscription-limit row text.
const LIMIT_PHRASE = "You've hit your limit";
// §9.5: the `note` hook's answers (plugins/watchdog/hooks/note/install.ts and note/guard.ts).
const NOTE_ACKS = ['Queued. Do not re-raise.', 'Dropped: '];
// §5.3: the dump warning of a project `env.CLAUDE_WATCHDOG` (plugins/watchdog/hooks/lifecycle/headless.ts).
const ENV_DENY = 'CLAUDE_WATCHDOG is ignored, because the project settings set it in env';
// §7.7: the heading of part 2 of a review prompt on the primary agent (plugins/watchdog/hooks/review/prompt.ts).
const PROMPTS_PART = "### The person's prompts since the watchdog started";

// A one-word prompt: one model step and no tool round, so the main `turn.complete` is the turn's only boundary
// (§7.2), and the word finds the turn in the observer log.
const wordPrompt = (word) => `Reply with the single word ${word}. Do not use any tool.`;

// ---------------------------------------------------------------- helpers

// Polls `test()` once a second until it holds or `timeoutMs` passed; resolves whether it held.
const until = async (test, timeoutMs) => {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    if (test()) {
      return true;
    }
    await sleep(1000);
  }
  return test();
};

const isWatchdogType = (type) => String(type ?? '').startsWith('watchdog:');

const flat = (text, max = 220) =>
  clip(
    String(text ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    max
  );

// §10.7: the wrapper XML-escapes a note text, so a delivered note is found by the head of its escaped text.
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const noteHead = (text) =>
  String(text)
    .trim()
    .replaceAll(/[&<>"]/gu, (char) => XML_ESCAPES[char])
    .slice(0, 40);

// The `command.run.out` of a command after `after` (ms since the epoch), as the observer saw it.
const replyOf = (run, command, args, after, timeoutMs = 30_000) =>
  waitObs(
    run,
    (events) =>
      ofEvent(
        events,
        'command.run.out',
        (event) => event.command === command && event.args === args && event.t > after
      )[0],
    { timeoutMs }
  );

// Every spawned review has ended. A review that spawns the next one in its own `turn.complete` (§7.5) logs the
// spawn before its own end, so a chain of reviews never looks settled early.
const isSettled = (events) => agentTurnCompletes(events).length >= watchdogSpawns(events).length;

// The review spawns of the mod in time order: the `agent.spawn.in` prompt (the observer clips it at 4000 chars),
// the origin, and the agentId of the matching `agent.spawn.out`.
const reviewSpawns = (events) => {
  const outs = ofEvent(events, 'agent.spawn.out', (event) => isWatchdogType(event.subagentType));
  const taken = new Set();
  return ofEvent(events, 'agent.spawn.in', (event) => isWatchdogType(event.subagentType)).map((spawn) => {
    const out = outs.find((row) => !taken.has(row) && row.t >= spawn.t && row.subagentType === spawn.subagentType);
    taken.add(out);
    return {
      t: spawn.t,
      type: spawn.subagentType,
      origin: spawn.origin,
      prompt: String(spawn.prompt ?? ''),
      agentId: out?.result?.agentId ?? null,
    };
  });
};

// The span of each main-loop turn: its `turn.start` to its `turn.complete` (same `turnId`), with its prompt.
const mainTurns = (events) => {
  const ends = mainTurnCompletes(events);
  return ofEvent(events, 'turn.start', (event) => !event.agentId).map((start) => {
    const end = ends.find((row) => row.turnId === start.turnId) ?? null;
    return { from: start.t, to: end?.t ?? Number.POSITIVE_INFINITY, text: String(start.text ?? ''), end };
  });
};

// The main turn whose prompt holds `word`, and whether it ended.
const turnOf = (events, word) => mainTurns(events).find((turn) => turn.text.includes(word)) ?? null;
const isTurnDone = (events, word) => turnOf(events, word)?.end != null;

// §7.2: the span of each `turn.complete` hook of one loop (agentId null = the main loop). The observer's `*` hook
// logs the event on the way in and its `turn.complete` hook after `next(e)`, so a spawn that the watchdog's own
// `turn.complete` hook awaited falls in between.
const completeSpans = (events, agentId = null) => {
  const outs = ofEvent(events, 'turn.complete', (event) => (event.agentId ?? null) === agentId);
  return ofEvent(events, 'star', (event) => event.event === 'turn.complete' && (event.agentId ?? null) === agentId).map(
    (star) => {
      const end = outs.find((row) => row.t >= star.t) ?? null;
      return { from: star.t, to: end?.t ?? Number.POSITIVE_INFINITY, end };
    }
  );
};

// §7.7: parts 3 and 4 of a review prompt, the ones built from the feed. Part 1 (the watchdog's own notes) and
// part 2 (the person's prompts) are left out.
const feedParts = (prompt) => {
  const starts = ['### Earlier updates', '### Session update']
    .map((head) => prompt.indexOf(head))
    .filter((at) => at >= 0);
  return starts.length === 0 ? '' : prompt.slice(Math.min(...starts));
};

// §7.7 part 4: the new updates.
const updatePart = (prompt) => {
  const at = prompt.indexOf('### Session update');
  return at === -1 ? '' : prompt.slice(at);
};

// §13.4: the full prompts of the last reviews in a `/watchdog dump raw` file, unquoted.
const dumpPrompts = (text) => {
  const at = String(text ?? '').indexOf('## Prompts of the last reviews');
  if (at === -1) {
    return [];
  }
  return text
    .slice(at)
    .split(/^### /mu)
    .slice(1)
    .map((block) =>
      block
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^> ?/u, ''))
        .join('\n')
        .trim()
    );
};

// §13.2, §11.3: the `$.ui.log` row of a note, `[<severity>( · <subagent type>)] <watchdog>: <text> (<state>)`.
const NOTE_STATES = 'steered|aside on next prompt|nudge pending|nudged|held|displaced|discarded|dropped:[\\w-]+';
const NOTE_ROW = new RegExp(
  `^\\[(nit|concern|blocker)(?: · ([^\\]]+))?\\] ([^:\\n]+): ([\\s\\S]*) \\((${NOTE_STATES})\\)$`,
  'u'
);

const noteLog = (events) =>
  ofEvent(events, 'ui.log', (event) => event.origin?.plugin === 'watchdog').flatMap((event) => {
    const match = NOTE_ROW.exec(String(event.text ?? ''));
    if (!match) {
      return [];
    }
    const [, severity, subagent, watchdog, text, state] = match;
    return [{ t: event.t, severity, subagent: subagent ?? null, watchdog, text, state }];
  });

// The plugin's `$.ui.log` rows: the observer's `ui.log` events, and in `-p` also the stream's `system/ui_log`.
const logTexts = (events, stream = []) => [
  ...ofEvent(events, 'ui.log', (event) => event.origin?.plugin === 'watchdog').map((event) => String(event.text ?? '')),
  ...stream
    .filter((event) => event.type === 'system' && event.subtype === 'ui_log' && event.plugin === 'watchdog')
    .map((event) => String(event.text ?? '')),
];

const isOwnOrigin = (event) => event.origin?.kind === 'plugin' && event.origin?.name === 'watchdog';

// §10.1, §10.3, §10.2: the main-loop rows that carry a `<watchdog-notes>` wrapper, by route: the steer row that the
// mod appends, the nudge prompt row, and the aside's hook-context row.
const wrapperRows = (events) =>
  ofEvent(events, 'session.append', (event) => !event.agentId && String(event.text ?? '').includes('<watchdog-notes'));
const steerRows = (events) => wrapperRows(events).filter((event) => isOwnOrigin(event) && event.door !== 'prompt');
const nudgeRows = (events) => wrapperRows(events).filter((event) => isOwnOrigin(event) && event.door === 'prompt');
const asideRows = (events) => wrapperRows(events).filter((event) => event.door === 'hook-context');

// The `<watchdog-notes>` blocks of the API view at a main `turn.complete` (observer field `notes.marks`).
const apiMarks = (end) => (end?.notes?.marks ?? []).map((mark) => String(mark.text ?? ''));

// The severity and the text of a `note` call, from its `tool.call.in` input (a clipped JSON string; the tool's
// arguments are `note` and `severity`, plugins/watchdog/hooks/note/tool.ts).
const noteInput = (events, toolUseId) => {
  const input = String(ofEvent(events, 'tool.call.in', (event) => event.tool_use_id === toolUseId)[0]?.input ?? '');
  const text = /"note":"((?:[^"\\]|\\.)*)"/u.exec(input)?.[1];
  let decoded = null;
  try {
    decoded = text === undefined ? null : JSON.parse(`"${text}"`);
  } catch {
    decoded = null;
  }
  return { severity: /"severity":"(\w+)"/u.exec(input)?.[1] ?? null, text: decoded };
};

// §14.3: the `session.end` events (the observer keeps `e` as a clipped JSON string): the reason and the ending id.
const sessionEnds = (events) =>
  ofEvent(events, 'session.end').map((event) => {
    try {
      const e = JSON.parse(String(event.e ?? '{}'));
      return { t: event.t, reason: e.reason ?? null, sessionId: e.sessionId ?? null };
    } catch {
      return { t: event.t, reason: null, sessionId: null };
    }
  });

const dumpTextOf = (dumps) => (dumps ?? []).map((dump) => dump.text).join('\n');
const reviewRecords = (dumps) => dumpReviews(dumpTextOf(dumps));

// §7.2: the debug file names the modules whose `agent.spawn` hooks a spawn ran through, for example
// `hooks module wdprobe@inline, watchdog@inline: agent.spawn nested in watchdog#42`. Returns the times of the
// lines that name the watchdog module, and whether the file has such lines at all.
const debugSpawnHooks = (file) => {
  const lines = readText(file)
    .split('\n')
    .flatMap((line) => {
      const match = /^(\S+) \[DEBUG\] hooks module ([^:]*): agent\.spawn nested in /u.exec(line);
      return match ? [{ t: Date.parse(match[1]), modules: match[2] }] : [];
    });
  const times = lines.filter((line) => /\bwatchdog@/u.test(line.modules)).map((line) => line.t);
  return { isLogged: lines.length > 0, times };
};

// The stream's tool results: what a Bash call printed.
const toolResultText = (events) =>
  events
    .filter((event) => event.type === 'user')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === 'tool_result')
    .flatMap((block) => (Array.isArray(block.content) ? block.content : [block.content]))
    .map((block) => (typeof block === 'string' ? block : (block?.text ?? '')))
    .join('\n');

// §15: the plugin's own price table (plugins/watchdog/hooks/prices.ts), read from its source: USD for each million
// tokens of each token class, by model id.
const priceTable = () => {
  const source = readText(path.join(PLUGIN_DIR, 'hooks', 'prices.ts'));
  const fields = (body) =>
    Object.fromEntries([...body.matchAll(/(\w+):\s*([\d.]+)/gu)].map(([, key, value]) => [key, Number(value)]));
  const named = Object.fromEntries(
    [...source.matchAll(/const (\w+): Price = \{([^}]*)\}/gu)].map(([, name, body]) => [name, fields(body)])
  );
  const table = /const PRICES[^=]*=\s*\{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    [...table.matchAll(/'([^']+)':\s*(?:\{([^}]*)\}|(\w+))/gu)].map(([, model, body, name]) => [
      model,
      body === undefined ? named[name] : fields(body),
    ])
  );
};

// §13.4: the usage line of a dump record, `26 input, 935 output, 12691 cache read, 7353 cache write`.
const usageOf = (text) => {
  const match = /^(\d+) input, (\d+) output, (\d+) cache read, (\d+) cache write$/u.exec(String(text ?? ''));
  return match
    ? {
        input_tokens: Number(match[1]),
        output_tokens: Number(match[2]),
        cache_read_input_tokens: Number(match[3]),
        cache_creation_input_tokens: Number(match[4]),
      }
    : null;
};

// §15: the USD of one usage at one price.
const usdOf = (usage, price) =>
  (usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.cacheWrite) /
  1_000_000;

// ---------------------------------------------------------------- TUI helpers

// Sends one tmux key `count` times at once (the driver's `keys` waits 250 ms after each key); if tmux refuses
// `-N`, one key at a time.
const repeatKey = async (tui, key, count) => {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'send-keys', '-t', tui.session, '-N', String(count), key], {
      stdio: 'ignore',
    });
  } catch {
    await tui.keys(...Array.from({ length: count }, () => key));
  }
};

// The text in the prompt box: the lines between the last two rules of the screen, without the `❯` mark; null
// when no box is drawn.
const inputText = (screen) => {
  const lines = String(screen).split('\n');
  const rules = lines.flatMap((line, index) => (/^─{20,}/u.test(line.trim()) ? [index] : []));
  if (rules.length < 2) {
    return null;
  }
  const [from, to] = rules.slice(-2);
  return lines
    .slice(from + 1, to)
    .join('\n')
    .replace(/^\s*❯\s?/u, '')
    .trim();
};

// Empties the prompt box (a restore puts the rewound prompt back in it): End, then one Backspace for each char.
const clearInput = async (tui) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = inputText(tui.screen());
    if (text === null || text === '') {
      return text === '';
    }
    await tui.keys('End');
    await repeatKey(tui, 'BSpace', text.length + 10);
    await sleep(800);
  }
  return inputText(tui.screen()) === '';
};

// The lines of the `/rewind` picker: the lines after its last `Rewind` title.
const pickerLines = (screen) => {
  const lines = String(screen).split('\n');
  const title = lines.findLastIndex((line) => /^\s*Rewind\s*$/u.test(line));
  return title === -1 ? [] : lines.slice(title + 1);
};

// The prompt the picker list has selected (its `❯` line), or null.
const selectedPrompt = (screen) =>
  pickerLines(screen)
    .find((line) => /^\s*❯/u.test(line))
    ?.replace(/^\s*❯\s*/u, '')
    .trim() ?? null;

// The numbered items of the picker's confirm list, e.g. `❯ 1. Restore code and conversation`,
// `2. Restore conversation`.
const confirmItems = (screen) =>
  pickerLines(screen).flatMap((line) => {
    const match = /^\s*(❯)?\s*(?:[↓↑]\s*)?(\d+)\.\s+(.+?)\s*$/u.exec(line);
    return match ? [{ isSelected: match[1] !== undefined, n: Number(match[2]), text: match[3] }] : [];
  });

// §14.4 on 2.1.290 (research/reprobe-2-1-290/logs/smoke-ar/rewind-screen-r1-*.txt): `/rewind` lists the person's
// prompts with `(current)` selected. Up selects a prompt, Enter opens the confirm list, whose item
// "Restore conversation" restores the conversation only. Returns what each step saw; `restored` is true once the
// picker closed and the answer of the rewound prompt left the screen.
const driveRewind = async (tui, run, word) => {
  const seen = { commandRun: false, opened: false, picked: false, confirmed: false, closed: false, restored: false };
  const before = tui.screen();
  const at = Date.now();
  await tui.type('/rewind');
  const opened = await tui.waitFor((text) => /Esc to cancel/u.test(text) && pickerLines(text).length > 0, {
    timeoutMs: 15_000,
  });
  seen.commandRun = (
    await waitObs(run, (events) => ofEvent(events, 'command.run.in', (e) => e.command === 'rewind' && e.t > at)[0], {
      timeoutMs: 5000,
    })
  ).ok;
  seen.picker = tui.capture('rewind-picker');
  seen.opened = opened.ok;
  if (!seen.opened) {
    return seen;
  }
  for (let step = 0; step < 6 && !(selectedPrompt(tui.screen()) ?? '').includes(word); step += 1) {
    await tui.keys('Up');
    await sleep(300);
  }
  seen.selected = selectedPrompt(tui.screen());
  seen.picked = (seen.selected ?? '').includes(word);
  if (!seen.picked) {
    return seen;
  }
  await tui.keys('Enter');
  const next = await tui.waitFor((text) => confirmItems(text).length > 0 || !/Esc to cancel/u.test(text), {
    timeoutMs: 10_000,
  });
  seen.confirm = tui.capture('rewind-confirm');
  const items = confirmItems(next.text);
  if (items.length > 0) {
    const goal =
      items.find((item) => item.text === 'Restore conversation') ??
      items.find((item) => /^Restore .*conversation/u.test(item.text));
    if (goal === undefined) {
      return seen;
    }
    const steps =
      items.indexOf(goal) -
      Math.max(
        items.findIndex((item) => item.isSelected),
        0
      );
    for (let step = 0; step < Math.abs(steps); step += 1) {
      await tui.keys(steps > 0 ? 'Down' : 'Up');
    }
    await sleep(300);
    seen.choice = confirmItems(tui.screen()).find((item) => item.isSelected)?.text ?? null;
    if (seen.choice !== goal.text) {
      return seen;
    }
    seen.confirmed = true;
    await tui.keys('Enter');
  }
  const closed = await tui.waitFor((text) => !/Esc to cancel|Confirm you want to restore/u.test(text), {
    timeoutMs: 10_000,
  });
  seen.closed = closed.ok;
  seen.after = tui.capture('rewind-after');
  const answer = new RegExp(`⏺\\s+${word}\\b`, 'iu');
  seen.restored = seen.closed && (!answer.test(before) || !answer.test(seen.after));
  return seen;
};

// ---------------------------------------------------------------- scenarios

// §16.1 L3 "session changes" (§5.4, §14.3, §14.4): one TUI session with a quiet haiku watchdog. `/watchdog on`,
// prompts ALPHA and BRAVO, `/rewind` to before BRAVO (as the 2.1.290 research did: a restore to a prompt that is not
// the first), prompt CHARLIE, `/clear`, `/resume <first id>`, prompt DELTA, `/branch`; `/watchdog status` after
// each session change. Each prompt has one review, which calls no note, so no nudge turn runs between the steps.
const SESSION_ROSTER = probeRoster({
  instructions:
    'This session is a live probe of the watchdog plugin. In every review, do not call note and do not use any ' +
    'tool; end the review with the single word done.',
});

export const sessionChanges = {
  id: 'l3-session',
  title: 'TUI: /watchdog on, a prompt, /rewind, a prompt, /clear, /resume <id>, a prompt, /branch',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'l3-session', { files: { 'WATCHDOG.json': SESSION_ROSTER } });
    const tui = await startTui(run, { label: 'tui' });
    const screens = {};
    try {
      const command = async (text, name, args, screen) => {
        const at = Date.now();
        await tui.type(text);
        const reply = await replyOf(run, name, args, at);
        await sleep(1000);
        screens[screen] = tui.capture(screen);
        return { at, ok: reply.ok, sessionId: reply.value?.sessionId ?? null, text: String(reply.value?.text ?? '') };
      };
      const ask = async (word) => {
        const at = Date.now();
        await tui.type(wordPrompt(word));
        const done = await waitObs(run, (events) => isTurnDone(events, word) && isSettled(events), {
          timeoutMs: 150_000,
        });
        // §10.3: a note, against the roster's instructions, would nudge 2 s after the review ends; let it run first.
        await sleep(3000);
        await tui.waitFor((text) => !BUSY.test(text), { timeoutMs: 60_000 });
        screens[word.toLowerCase()] = tui.capture(word.toLowerCase());
        return { at, ok: done.ok };
      };
      const on = await command('/watchdog on', 'watchdog', 'on', 'on');
      const alpha = await ask('ALPHA');
      const bravo = await ask('BRAVO');
      const s1 = on.sessionId ?? turnOf(readObs(run), 'ALPHA')?.end?.sessionId ?? null;
      const rewind = await driveRewind(tui, run, 'BRAVO');
      if (!rewind.closed) {
        await tui.keys('Escape', 'Escape');
        await sleep(1000);
      }
      rewind.isInputEmpty = await clearInput(tui);
      const charlie = await ask('CHARLIE');
      const clear = await command('/clear', 'clear', '', 'clear');
      const cleared = await command('/watchdog status', 'watchdog', 'status', 'status-cleared');
      const resume = s1 === null ? null : await command(`/resume ${s1}`, 'resume', s1, 'resume');
      const resumed = await command('/watchdog status', 'watchdog', 'status', 'status-resumed');
      const delta = await ask('DELTA');
      const branch = await command('/branch', 'branch', '', 'branch');
      const branched = await command('/watchdog status', 'watchdog', 'status', 'status-branched');
      return {
        run,
        screens,
        events: readObs(run),
        s1,
        on,
        alpha,
        bravo,
        rewind,
        charlie,
        clear,
        cleared,
        resume,
        resumed,
        delta,
        branch,
        branched,
      };
    } finally {
      await tui.stop();
    }
  },
};

// §16.1 L3 "roster parse" (§4.6, §6.3), "review trigger" (§7.2), "delivery" (§10.1, §10.2, §10.6) and the
// nested-run unset (§5.3), in one `CLAUDE_WATCHDOG=on` -p session with stream-json input:
// 1. `/watchdog status` lists the roster and its warnings (a command runs in stream-json, §16.4 #10 route 1);
// 2. WDOK has no tool round, so the main `turn.complete` hook spawns a review of each watchdog; their late notes
//    wait as asides (§10.6), alpha's a concern and beta's a nit;
// 3. WDSTEER carries the asides, reads a.txt (a step boundary spawns the reviews), then runs a Bash call that
//    prints CLAUDE_WATCHDOG and sleeps 60 s, so alpha's next concern is ready while that call runs and is
//    appended after its result (§10.1).
const ROSTER_FILE = {
  notAKey: 'ignored',
  maxNotesPerReview: 'not a number',
  instructions:
    'This session is a live probe of the watchdog plugin. In every review, call note exactly once with the ' +
    'severity and the text that your own instructions below give, then end the review with done.',
  watchdogs: [
    {
      name: 'alpha',
      model: 'haiku',
      effort: 'low',
      instructions:
        'Use severity concern. Start the note text with WDPROBE-A, then name the newest file the agent read in ' +
        'this update and quote its first line; if the agent read no file in this update, say that.',
    },
    {
      name: 'beta',
      model: 'haiku',
      effort: 'low',
      tools: ['Read', 'WebFetch'],
      instructions:
        'Use severity nit. Start the note text with WDPROBE-B, then say in a few words what the agent did in ' +
        'this update.',
    },
    { name: 'gamma', model: 'haiku', effort: 7 },
  ],
};

const STEER_PROMPT =
  'WDSTEER. Do these two steps in order, one tool call per step, and wait for each result: 1. Use the Read tool ' +
  'on a.txt. 2. Use the Bash tool to run exactly this command: echo "WD=${CLAUDE_WATCHDOG-unset}"; sleep 60 ' +
  'Then reply with the single word DONE.';

export const rosterSession = {
  id: 'l3-roster',
  title: 'CLAUDE_WATCHDOG=on -p: a project WATCHDOG.json with warnings, a turn.complete review, asides, a steer',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'l3-roster', { files: { 'WATCHDOG.json': ROSTER_FILE } });
    const sent = {};
    const p = await runHeadless(run, {
      label: 'p',
      env: { CLAUDE_WATCHDOG: 'on' },
      args: ['--allowedTools', 'Read,Bash'],
      input: async (send) => {
        sent.status = Date.now();
        send('/watchdog status');
        await replyOf(run, 'watchdog', 'status', 0);
        sent.ok = Date.now();
        send(wordPrompt('WDOK'));
        await waitObs(run, (events) => isTurnDone(events, 'WDOK') && isSettled(events), { timeoutMs: 150_000 });
        sent.steer = Date.now();
        send(STEER_PROMPT);
        await waitObs(run, (events) => isTurnDone(events, 'WDSTEER') && isSettled(events), { timeoutMs: 240_000 });
      },
      closeAfterMs: 5000,
      timeoutMs: 480_000,
    });
    await sleep(2000);
    const events = readObs(run);
    const ids = [p.sessionId, ofEvent(events, 'session.start')[0]?.sessionId];
    return { run, p, sent, events, dumps: collectDumps(run, ids) };
  },
};

// §16.1 L3 "subagent review" (§11, §16.5 late subagent notes): a roster with `subagents: { Explore: true }` and a
// prompt that asks for one Explore subagent; then a second prompt, which carries the late notes as an aside.
const SUBAGENT_PROMPT =
  'WDSUB. Use the Agent tool exactly once, with subagent_type Explore, to find the file in this folder that ' +
  'defines the function add and what add returns. Then reply in one line with what it found.';

export const subagentReview = {
  id: 'l3-subagent',
  title: 'CLAUDE_WATCHDOG=on -p with subagents { Explore: true }: one Explore subagent, then one more prompt',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'l3-subagent', {
      files: { 'WATCHDOG.json': probeRoster({ subagents: { Explore: true } }) },
    });
    const p = await runHeadless(run, {
      label: 'p',
      env: { CLAUDE_WATCHDOG: 'on' },
      args: ['--allowedTools', 'Agent,Read,Grep,Glob'],
      input: async (send) => {
        send(SUBAGENT_PROMPT);
        await waitObs(run, (events) => isTurnDone(events, 'WDSUB') && isSettled(events), { timeoutMs: 240_000 });
        send(wordPrompt('WDAFTER'));
        await waitObs(run, (events) => isTurnDone(events, 'WDAFTER') && isSettled(events), { timeoutMs: 120_000 });
      },
      closeAfterMs: 5000,
      timeoutMs: 480_000,
    });
    await sleep(2000);
    return {
      run,
      p,
      events: readObs(run),
      dumps: collectDumps(run, [p.sessionId]),
      subagents: subagentTranscripts(p.sessionId),
    };
  },
};

// §16.1 L3 "headless route: the project env deny" (§5.3): project settings set `env.CLAUDE_WATCHDOG`, and the
// shell sets it too. The session stays off; only `/watchdog status` runs, so no model is called.
export const projectEnvDeny = {
  id: 'l3-project-env',
  title: 'CLAUDE_WATCHDOG=on -p with project settings env.CLAUDE_WATCHDOG: /watchdog status, no prompt',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'l3-project-env', {
      files: { 'WATCHDOG.json': probeRoster(), '.claude/settings.json': { env: { CLAUDE_WATCHDOG: 'on' } } },
    });
    const p = await runHeadless(run, {
      label: 'p',
      env: { CLAUDE_WATCHDOG: 'on' },
      input: async (send) => {
        send('/watchdog status');
        await replyOf(run, 'watchdog', 'status', 0);
      },
      closeAfterMs: 3000,
      timeoutMs: 90_000,
    });
    await sleep(1000);
    const events = readObs(run);
    return { run, p, events, dumps: collectDumps(run, [p.sessionId, ofEvent(events, 'session.start')[0]?.sessionId]) };
  },
};

// §16.1 L3 "failure state machine: real limit rows" (§12.2, §12.3 item 3, §12.5). Opt-in: the account is at its
// subscription limit now (`--with account:limit`), so the main loop fails too. WDLIMIT1's boundary spawns a review
// that gets the limit row; WDLIMIT2, a person prompt, tries one review with the kept backlog.
export const limitState = {
  id: 'l3-limit',
  title: 'Account at its subscription limit: two one-word prompts in a CLAUDE_WATCHDOG=on -p session',
  needs: ['account:limit'],
  run: async (ctx) => {
    const run = createRun(ctx, 'l3-limit', { files: { 'WATCHDOG.json': probeRoster() } });
    const p = await runHeadless(run, {
      label: 'p',
      env: { CLAUDE_WATCHDOG: 'on' },
      input: async (send) => {
        send(wordPrompt('WDLIMIT1'));
        await waitObs(run, (events) => isTurnDone(events, 'WDLIMIT1') && isSettled(events), { timeoutMs: 120_000 });
        await sleep(2000);
        send(wordPrompt('WDLIMIT2'));
        await waitObs(run, (events) => isTurnDone(events, 'WDLIMIT2') && isSettled(events), { timeoutMs: 120_000 });
      },
      closeAfterMs: 5000,
      timeoutMs: 330_000,
    });
    await sleep(2000);
    return { run, p, events: readObs(run), dumps: collectDumps(run, [p.sessionId]) };
  },
};

// ---------------------------------------------------------------- verify helpers

// §10.3: the main `turn.start` events of nudge turns, whose text starts with the engine's frame.
const nudgeStarts = (events) =>
  ofEvent(events, 'turn.start', (event) => !event.agentId && String(event.text).startsWith(NUDGE_FRAME));

// §13.1: the band's count line is a rule that names each severity of the open cards with its count
// (`── watchdog · 2 concerns · 1 nit ──…`). A full card row reads `a: ▸  <SEVERITY>  <watchdog> · …`, cut with
// `…` at the edge; its tail holds the outdated mark (§10.8), the sentence, the age and the delivery state.
const SEVERITY_WORD = '(?:blockers?|concerns?|nits?)';
const BAND_CARD = new RegExp(`^\\s*(?:[a-c]: [▸▾]\\s+)?(BLOCKER|CONCERN|NIT)\\s+(\\S+) · ([^\\n]*)$`, 'gmu');

// §5.4: a session change keeps the on flag; the `/watchdog status` reply after it starts with `watchdog on`.
const ON_KEPT = 'the on flag carried over: the status reads "watchdog on"';
const isOnReply = (reply) => String(reply?.text ?? '').startsWith('watchdog on');

// §7.3: how each own item would read if it leaked into the feed parts of a review prompt (feed/render.ts renders a
// row of another origin as `[<label>] <one line>` and a tool call as `→ <tool>(…)`).
const ECHOES = [
  ['§7.3 item 2: a steer or nudge row of the mod', /^\[plugin watchdog\]/mu],
  [
    '§7.3 items 2, 3: a delivered <watchdog-notes> wrapper',
    /^\[[^\]\n]+\][^\n]*(?:<watchdog-notes|The watchdog plugin sent a message:)/mu,
  ],
  ['§7.3 item 1: a note or resolve call of a watchdog agent', /→ mcp__watchdog__(?:note|resolve)\(/u],
  ['§7.3 item 1: the spawn prompt row of a watchdog agent', /^\[coordinator\]/mu],
  ['§7.3 items 4, 5: a synthetic Agent call of a spawn', /toolu_plugin_/u],
  ['§7.3 item 6: the stopped-review prompt', /Background agent "[^"\n]*" was stopped by the user/u],
];

const echoesIn = (text, ids) => [
  ...ECHOES.filter(([, pattern]) => pattern.test(text)).map(([item]) => item),
  ...[...ids].filter((id) => text.includes(id)).map((id) => `§7.3 items 1, 4: the id of watchdog agent ${id}`),
];

// §7.3: no review prompt carries an own item in its feed parts. `prompts` are the prompts to search; a prompt
// can only echo the watchdog once it acted, so at least one must come after a note call.
const echoVerdict = (events, prompts, label) => {
  const ids = new Set(reviewSpawns(events).flatMap((spawn) => (spawn.agentId ? [spawn.agentId] : [])));
  const firstNote = noteCalls(events)[0]?.t ?? Number.POSITIVE_INFINITY;
  const later = prompts.filter((prompt) => prompt.t > firstNote);
  if (later.length === 0) {
    return inconclusive([
      `no review prompt came after a note call (${prompts.length} prompts, ${noteCalls(events).length} note calls)`,
    ]);
  }
  const hits = prompts.flatMap((prompt) =>
    echoesIn(feedParts(prompt.text), ids).map((item) => `${prompt.from}: ${item}`)
  );
  const evidence = [
    `${label}: ${prompts.length} prompts searched (${later.length} after the first note call), ${ids.size} agent ids`,
    `prompts at the observer's 4000-char clip: ${prompts.filter((prompt) => prompt.text.length >= 4000).length}`,
  ];
  return hits.length === 0
    ? pass([...evidence, 'no own row, note call, wrapper, agent prompt, synthetic call or agent id in parts 3 and 4'])
    : fail([`own items leaked into review prompts: ${hits.length}`, ...[...new Set(hits)].slice(0, 6), ...evidence]);
};

// The review prompts of the TUI scenario: the spawn prompts (clipped) and the full ones of the raw dump.
const tuiPrompts = (obs) => [
  ...reviewSpawns(obs.events).map((spawn) => ({ t: spawn.t, from: `spawn ${spawn.agentId}`, text: spawn.prompt })),
  ...dumpPrompts(obs.dump?.text).map((text, index) => ({
    t: Number.POSITIVE_INFINITY,
    from: `dump prompt ${index + 1}`,
    text,
  })),
];

// ---------------------------------------------------------------- checks

const TRIGGER = '§16.1 L3: review trigger: a spawn from the main turn.complete hook reaches the mod';
const SELF_REVIEW = '§16.1 L3: self-review filter: the real echoes';
const DELIVERY = '§16.1 L3: delivery: the real append and nudge';
const COMMANDS = '§16.1 L3: /watchdog commands, dump: type /watchdog status';
const SESSION = '§16.1 L3: session changes: /clear, /resume, /branch, /rewind';
const FAILURE = '§16.1 L3: failure state machine: real limit rows';
const ROSTER = '§16.1 L3: roster parse: load a project WATCHDOG.json';
const COST = '§16.1 L3: price table, cost: real usage';
const BAND = '§16.1 L3: band cards: paint';
const SUBAGENT = '§16.1 L3: subagent review: the late subagent notes of §16.5';
const HEADLESS = '§16.1 L3: headless route: the route, the nested-run unset, the project env deny';

export const checks = [
  {
    id: 'l3-review-trigger',
    title: 'The main turn.complete hook spawns a review of each watchdog; its note calls and its end reach the mod',
    source: TRIGGER,
    kind: 'deterministic',
    scenario: 'l3-roster',
    needs: [],
    verify: (obs) => {
      const turn = turnOf(obs.events, 'WDOK');
      if (turn?.end == null) {
        return fail(['the WDOK prompt never ended: no main turn.complete', `run: ${obs.run.dir}`]);
      }
      const span = completeSpans(obs.events).find((item) => item.end === turn.end);
      const spawns = reviewSpawns(obs.events).filter((spawn) => span && spawn.t >= span.from && spawn.t <= span.to);
      const steps = ofEvent(
        obs.events,
        'turn.step',
        (event) => !event.agentId && event.t >= turn.from && event.t <= turn.to && (event.index ?? 0) >= 1
      );
      if (spawns.length === 0 && steps.length > 0) {
        return inconclusive([
          `the model used a tool in WDOK (${steps.length} main steps of index 1 or more), so a step boundary ` +
            'came first',
          `run: ${obs.run.dir}`,
        ]);
      }
      const ids = spawns.flatMap((spawn) => (spawn.agentId ? [spawn.agentId] : []));
      const notes = noteCalls(obs.events).filter((call) => ids.includes(call.agentId));
      const acked = notes.filter((call) => NOTE_ACKS.some((ack) => String(call.result).includes(ack)));
      const ended = new Set(agentTurnCompletes(obs.events).map((end) => end.agentId));
      const recorded = new Set(reviewRecords(obs.dumps).map((record) => record.agentId));
      const debug = debugSpawnHooks(obs.p.debugFile);
      const hooked = spawns.filter((spawn) => debug.times.some((time) => Math.abs(time - spawn.t) < 1000));
      const types = spawns.map((spawn) => spawn.type);
      const spanMs = span ? span.to - span.from : '?';
      const evidence = [
        `WDOK turn.complete hook span ${spanMs} ms; spawns in it: ${types.join(', ') || 'none'}`,
        `agents ${ids.join(', ') || 'none'}; note calls ${notes.length}, answered by the note hook ${acked.length}`,
        ...notes.slice(0, 2).map((call) => clip(`note result: ${call.result}`, 160)),
        debug.isLogged
          ? `debug: the watchdog module's agent.spawn hook ran for ${hooked.length} of ${spawns.length} spawns`
          : 'debug: the file names no agent.spawn hook dispatch; not used',
        `run: ${obs.run.dir}`,
      ];
      const verdict = expectAll(
        {
          'the main turn.complete hook spawned watchdog:alpha and watchdog:beta': [
            'watchdog:alpha',
            'watchdog:beta',
          ].every((type) => types.includes(type)),
          'each spawn resolved an agentId': spawns.length > 0 && ids.length === spawns.length,
          "each agent's turn.complete was logged": ids.every((id) => ended.has(id)),
          "the mod wrote a dump record for each review (its turn.complete hook saw the agent's end)": ids.every((id) =>
            recorded.has(id)
          ),
          "every note call of these agents got the note hook's answer": notes.length === acked.length,
          "the watchdog module's agent.spawn hook ran for each spawn":
            !debug.isLogged || hooked.length === spawns.length,
        },
        evidence
      );
      return verdict.status === 'pass' && notes.length === 0
        ? inconclusive(['the spawn and the end reached the mod, but no agent called note', ...verdict.evidence])
        : verdict;
    },
  },
  {
    id: 'l3-self-review-headless',
    title: 'In -p, no review prompt carries an own row, note call, wrapper or agent id in its feed parts',
    source: SELF_REVIEW,
    kind: 'deterministic',
    scenario: 'headless-review',
    needs: [],
    verify: (obs) =>
      echoVerdict(
        obs.events,
        reviewSpawns(obs.events).map((spawn) => ({ t: spawn.t, from: `spawn ${spawn.agentId}`, text: spawn.prompt })),
        'headless-review'
      ),
  },
  {
    id: 'l3-self-review-tui',
    title: 'In the TUI, no review prompt carries an own row, nudge, wrapper or agent id in its feed parts',
    source: SELF_REVIEW,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => echoVerdict(obs.events, tuiPrompts(obs), 'tui-review'),
  },
  {
    id: 'l3-self-review-log-rows',
    title: "The watchdog's own $.ui.log note rows do not come back into its next review prompt",
    source: SELF_REVIEW,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const rows = noteLog(obs.events);
      const prompts = tuiPrompts(obs);
      const later = prompts.filter((prompt) => prompt.t > (rows[0]?.t ?? Number.POSITIVE_INFINITY));
      if (rows.length === 0 || later.length === 0) {
        return inconclusive([`note rows ${rows.length}; review prompts after the first row ${later.length}`]);
      }
      const echo = /^\[notice[^\]\n]*\] watchdog: [^\n]*/mu;
      const hits = prompts.flatMap((prompt) => {
        const line = echo.exec(feedParts(prompt.text))?.[0];
        return line === undefined ? [] : [`${prompt.from}: ${clip(line, 200)}`];
      });
      return hits.length === 0
        ? pass([`${prompts.length} review prompts, ${rows.length} note rows: no own log row in parts 3 and 4`])
        : fail([
            "§7.3 (the watchdog never reviews itself; item 3, its own delivered notes): the engine echoes the mod's " +
              '$.ui.log row as a `notice` session row, and the feed keeps it',
            ...[...new Set(hits)].slice(0, 4),
            `run: ${obs.run.dir}`,
          ]);
    },
  },
  {
    id: 'l3-delivery-nudge',
    title: 'A late note goes out as one plugin prompt: the nudge row, the frame and the wrapper reach the model',
    source: DELIVERY,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      // §10.3: a note of the nudge route is admitted as `nudge pending`; its nudge then sends it.
      const nudged = noteLog(obs.events).filter((row) => row.state === 'nudge pending');
      if (nudged.length === 0) {
        return inconclusive([
          `no note took the nudge route; note states: ${
            noteLog(obs.events)
              .map((row) => row.state)
              .join(', ') || 'none'
          }`,
        ]);
      }
      const submits = ofEvent(obs.events, 'prompt.submit', (event) => !event.agentId && isOwnOrigin(event));
      const frames = nudgeStarts(obs.events);
      const rows = nudgeRows(obs.events);
      const turn = frames[0] ? mainTurns(obs.events).find((item) => item.from === frames[0].t) : null;
      const marks = apiMarks(turn?.end);
      const lastEnd = ofEvent(obs.events, 'turn.complete', (event) => event.t < (submits[0]?.t ?? 0)).at(-1);
      return expectAll(
        {
          'one $.prompt.submit with origin plugin watchdog': submits.length === 1,
          'its turn.start text starts with the frame "The watchdog plugin sent a message:"': frames.length === 1,
          'the nudge row (door prompt, origin plugin watchdog) holds every nudged note': nudged.every((note) =>
            rows.some((row) => String(row.text).includes(noteHead(note.text)))
          ),
          "the nudge turn's API view has the <watchdog-notes> block": marks.length > 0,
        },
        [
          ...nudged.slice(0, 2).map((note) => clip(`nudged: ${note.text}`, 160)),
          `submit ${submits[0] ? submits[0].t - (lastEnd?.t ?? submits[0].t) : '?'} ms after the last turn.complete`,
          clip(`nudge row: ${flat(rows[0]?.text, 200)}`, 220),
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-delivery-read',
    title: 'The model answers the nudge turn on the note: its source or the fact it names',
    source: DELIVERY,
    kind: 'advisory',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const frame = nudgeStarts(obs.events)[0];
      const turn = frame ? mainTurns(obs.events).find((item) => item.from === frame.t) : null;
      if (turn?.end == null) {
        return inconclusive(['no nudge turn ran']);
      }
      const answer = String(turn.end.answer ?? '');
      // The wrapper asks the model not to address the watchdog (§10.7), so an answer may name only the fact: the
      // probe note always names the planted bug of math.js (`add` returns a - b, so add(2, 3) is -1).
      return /watchdog|note|feedback|review|WDPROBE|a\s*-\s*b|subtract|-1\b/iu.test(answer)
        ? pass([`nudge turn answer: ${flat(answer, 200)}`])
        : fail([`the nudge turn answer names neither the note nor its fact: ${flat(answer, 200)}`]);
    },
  },
  {
    id: 'l3-delivery-steer',
    title: 'A concern ready during a main turn is appended at the next main-loop tool result, inside the turn',
    source: DELIVERY,
    kind: 'deterministic',
    scenario: 'l3-roster',
    needs: [],
    // §10.1: a ready steer waits for the next main-loop tool result and goes out after its `next(e)`. A note that
    // came within 200 ms of a result may have missed that result's steer, so the next result after that counts.
    verify: (obs) => {
      const synthetic = new Set(
        ofEvent(obs.events, 'tool.call.in', (event) => String(event.tool_use_id ?? '').startsWith('toolu_plugin_')).map(
          (event) => event.tool_use_id
        )
      );
      const outs = ofEvent(obs.events, 'tool.call.out', (event) => !event.agentId && !synthetic.has(event.tool_use_id));
      const turns = mainTurns(obs.events);
      const due = noteCalls(obs.events)
        .filter((call) => String(call.result).includes(NOTE_ACKS[0]))
        .map((call) => ({ t: call.t, ...noteInput(obs.events, call.tool_use_id) }))
        .filter((note) => (note.severity === 'concern' || note.severity === 'blocker') && note.text !== null)
        .flatMap((note) => {
          const turn = turns.find((item) => note.t >= item.from && note.t <= item.to);
          const out = turn ? outs.find((row) => row.t > note.t + 200 && row.t <= turn.to) : undefined;
          return out ? [{ ...note, out, turn }] : [];
        });
      if (due.length === 0) {
        return inconclusive([
          'no concern was admitted during a main turn that had a tool result after it',
          `main tool results: ${outs.map((row) => row.tool).join(', ') || 'none'}; ` +
            `note calls ${noteCalls(obs.events).length}`,
        ]);
      }
      // The note's `tool.call.out` is logged after the note hook admitted it, so a steer may precede it by a few ms.
      const rows = steerRows(obs.events);
      const landed = due.filter((note) =>
        rows.some(
          (row) =>
            row.t >= note.t - 1000 && row.t <= note.out.t + 5000 && String(row.text).includes(noteHead(note.text))
        )
      );
      const outside = rows.filter((row) => !turns.some((turn) => row.t >= turn.from && row.t <= turn.to));
      return expectAll(
        {
          'each such concern was appended at the next main tool result': landed.length === due.length,
          'every steer row lies inside a main turn': outside.length === 0,
          "the turn's API view has the <watchdog-notes> block": due.every((note) => apiMarks(note.turn.end).length > 0),
        },
        [
          ...due
            .slice(0, 2)
            .map((note) => clip(`${note.out.t - note.t} ms before the ${note.out.tool} result: ${note.text}`, 180)),
          `steer rows ${rows.length} (doors ${[...new Set(rows.map((row) => row.door))].join(', ') || 'none'})`,
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-delivery-aside',
    title: 'Late notes and nits of a -p run go as one aside on the next sdk prompt, nit included',
    source: DELIVERY,
    kind: 'deterministic',
    scenario: 'l3-roster',
    needs: [],
    verify: (obs) => {
      const prompt = ofEvent(
        obs.events,
        'prompt.submit',
        (event) => !event.agentId && String(event.text).includes('WDSTEER')
      )[0];
      if (!prompt) {
        return fail(['the WDSTEER prompt never reached prompt.submit', `run: ${obs.run.dir}`]);
      }
      const waiting = noteLog(obs.events).filter(
        (row) => row.t < prompt.t && row.state === 'aside on next prompt' && row.subagent === null
      );
      if (waiting.length === 0) {
        return inconclusive(['no note waited as an aside before WDSTEER']);
      }
      const rows = asideRows(obs.events).filter((row) => row.t >= prompt.t && row.t <= prompt.t + 15_000);
      const text = rows.map((row) => String(row.text)).join('\n');
      const turn = turnOf(obs.events, 'WDSTEER');
      const nits = waiting.filter((row) => row.severity === 'nit');
      return expectAll(
        {
          'the WDSTEER prompt got a hook-context row with the wrapper': rows.length > 0,
          'the aside holds every note that waited': waiting.every((row) => text.includes(noteHead(row.text))),
          'a nit that waited is in it as severity="nit"': nits.length === 0 || text.includes('severity="nit"'),
          "the WDSTEER turn's API view has the <watchdog-notes> block": apiMarks(turn?.end).length > 0,
        },
        [
          ...waiting.slice(0, 3).map((row) => clip(`[${row.severity}] ${row.watchdog}: ${row.text}`, 160)),
          `nits that waited: ${nits.length}`,
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-status-reply',
    title: '/watchdog status answers the on state, the on source and one row for each watchdog with its file',
    source: COMMANDS,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const text = String(obs.status?.text ?? '');
      return expectAll(
        {
          'the first line reads "watchdog on"': /^watchdog on(?: · |$)/u.test(text),
          'the on source line reads "on source: /watchdog on"': /^on source: \/watchdog on$/mu.test(text),
          'a row "probe <state> · ./WATCHDOG.json"': /^probe \S+(?: · [^\n]*)? · \.\/WATCHDOG\.json$/mu.test(text),
        },
        [`reply: ${flat(text, 240)}`, `run: ${obs.run.dir}`]
      );
    },
  },
  {
    id: 'l3-status-table',
    title: '/watchdog status draws the §13.3 table: header, the watchdog row with its state, cost and file',
    source: COMMANDS,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const screen = String(obs.screens?.status ?? '');
      const header = /name\s+model\s+state\s+reviews\s+notes\s+tokens\s+cost\s+file/u.test(screen);
      const row = /^\s*probe\s+\S+\s+\S+.*\$(?:\d|<|\?).*\.\/WATCHDOG\.json/mu.test(screen);
      return header && row
        ? pass([
            'the table header and the probe row are drawn',
            flat(screen.split('\n').find((line) => /^\s*probe\s/u.test(line))),
          ])
        : fail([
            `the status draws no §13.3 table: header ${header}, probe row with cost and file ${row}`,
            `command.run.out text: ${flat(obs.status?.text, 160)}`,
            `screen tail: ${flat(screen.split('\n').slice(-20).join(' '), 220)}`,
            `run: ${obs.run.dir}`,
          ]);
    },
  },
  {
    id: 'l3-dump-raw',
    title: '/watchdog dump raw writes <config>/watchdog/dumps/<sessionId>-<time>.md with the records and prompts',
    source: COMMANDS,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const reply = String(obs.dumpReply?.text ?? '');
      const named = /^watchdog dump: (\S+\.md)$/u.exec(reply)?.[1] ?? null;
      const sessionId = obs.dumpReply?.sessionId ?? obs.status?.sessionId ?? null;
      const text = obs.dump?.text ?? '';
      return expectAll(
        {
          'the reply names the file': named !== null,
          'the file is <sessionId>-<YYYYMMDD-HHmmss>.md under watchdog/dumps': new RegExp(
            `/watchdog/dumps/${sessionId}-\\d{8}-\\d{6}\\.md$`,
            'u'
          ).test(named ?? ''),
          'the file was written with its title': text.startsWith('# watchdog dump'),
          'it names the session': text.includes(`- session: ${sessionId}`),
          'it holds a review record': dumpReviews(text).length > 0,
          'raw adds the prompts of the last reviews': dumpPrompts(text).length > 0,
        },
        [`reply: ${clip(reply, 200)}`, `file: ${obs.dump?.file ?? 'none'} (${text.length} chars)`]
      );
    },
  },
  {
    id: 'l3-price-cost',
    title: "Each review record's usage is the agent's real turn.complete usage, and its cost is the price table's",
    source: COST,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const records = dumpReviews(obs.dump?.text ?? '').filter((record) => usageOf(record.usage) !== null);
      if (records.length === 0) {
        return inconclusive([`no review record with usage; dump written: ${obs.dump != null}`]);
      }
      const prices = priceTable();
      const ends = agentTurnCompletes(obs.events);
      const rows = records.map((record) => {
        const usage = usageOf(record.usage);
        const model = String(record.model ?? '')
          .split(',')[0]
          .trim();
        const price = prices[model];
        const end = ends.find((item) => item.agentId === record.agentId)?.usage ?? null;
        const isReal =
          end !== null &&
          ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(
            (key) => end[key] === usage[key]
          );
        const expected = price === undefined ? '$?' : `$${usdOf(usage, price).toFixed(4)}`;
        return { record, model, isReal, expected, isPriced: price !== undefined && record.cost === expected };
      });
      return expectAll(
        {
          "each record's usage equals its agent's turn.complete usage": rows.every((row) => row.isReal),
          'each model is in the price table and the cost is usage times price': rows.every((row) => row.isPriced),
        },
        [
          ...rows.slice(0, 3).map((row) => {
            const { agentId, usage, cost } = row.record;
            return clip(`${agentId} ${row.model}: ${usage} → ${cost} (expected ${row.expected})`, 220);
          }),
          `price table models: ${Object.keys(prices).join(', ')}`,
        ]
      );
    },
  },
  {
    id: 'l3-band-cards',
    title: 'With notes, the band paints the count line and up to 3 cards with name, age and delivery state',
    source: BAND,
    kind: 'deterministic',
    scenario: 'tui-review',
    needs: [],
    verify: (obs) => {
      const rows = noteLog(obs.events).filter((row) => !row.state.startsWith('dropped'));
      if (rows.length === 0) {
        return inconclusive(['the watchdog sent no note, so the band has no card to paint']);
      }
      const screen = String(obs.screens?.idle ?? '');
      const count = new RegExp(`^── watchdog · (\\d+ ${SEVERITY_WORD}(?: · \\d+ ${SEVERITY_WORD})*)`, 'mu').exec(
        screen
      );
      const cards = [...screen.matchAll(BAND_CARD)];
      return expectAll(
        {
          'the count line names the severities with their counts': count !== null,
          'at least one card is painted': cards.length > 0,
          'at most 3 cards, then a "+N more" line':
            cards.length <= 3 && (rows.length <= 3 || /\+\d+ more/u.test(screen)),
          'each card names the watchdog probe': cards.every((card) => card[2] === 'probe'),
        },
        [
          `count line: ${count?.[0] ?? 'none'}; note rows ${rows.length}`,
          ...cards.slice(0, 3).map((card) => flat(card[0], 160)),
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-band-cards-empty',
    title: 'With no open note, the band paints only the count line "watchdog · no open notes"',
    source: BAND,
    kind: 'deterministic',
    scenario: 'l3-session',
    needs: [],
    verify: (obs) => {
      const screen = String(obs.screens?.on ?? '');
      const card = /^\s*(?:[a-c]: [▸▾]\s+)?(BLOCKER|CONCERN|NIT)\s+\S+ · /mu.test(screen);
      return expectAll(
        {
          'the count line reads "watchdog · no open notes"': /^── watchdog · no open notes/mu.test(screen),
          'no card is painted': !card,
        },
        [flat(screen.split('\n').find((line) => line.startsWith('── watchdog · ')) ?? 'no count line', 160)]
      );
    },
  },
  {
    id: 'l3-session-clear',
    title: '/clear gives a new session id, ends the old one with reason clear, and keeps the on flag',
    source: SESSION,
    kind: 'deterministic',
    scenario: 'l3-session',
    needs: [],
    verify: (obs) => {
      const s2 = obs.cleared?.sessionId ?? null;
      const ends = sessionEnds(obs.events);
      return expectAll(
        {
          'the first session id is known': obs.s1 !== null,
          '/clear ran': obs.clear?.ok === true,
          'a new session id after /clear': s2 !== null && s2 !== obs.s1,
          [ON_KEPT]: isOnReply(obs.cleared),
          'session.end with reason clear on the first id': ends.some(
            (end) => end.reason === 'clear' && end.sessionId === obs.s1
          ),
          'one session.start in the process (no reload)': ofEvent(obs.events, 'session.start').length === 1,
        },
        [`${obs.s1} → ${s2}`, `session.end: ${ends.map((end) => `${end.reason} ${end.sessionId}`).join(', ')}`]
      );
    },
  },
  {
    id: 'l3-session-resume',
    title: '/resume <id> brings the first id back with the on flag, and the next review replays its conversation',
    source: SESSION,
    kind: 'deterministic',
    scenario: 'l3-session',
    needs: [],
    verify: (obs) => {
      const s2 = obs.cleared?.sessionId ?? null;
      const review = reviewSpawns(obs.events).find((spawn) => obs.delta && spawn.t >= obs.delta.at);
      return expectAll(
        {
          '/resume <first id> ran': obs.resume?.ok === true,
          'the session id is the first one again': obs.resumed?.sessionId === obs.s1,
          [ON_KEPT]: isOnReply(obs.resumed),
          'session.end with reason resume on the cleared id': sessionEnds(obs.events).some(
            (end) => end.reason === 'resume' && end.sessionId === s2
          ),
          'the DELTA review has the replay marker in its update': updatePart(review?.prompt ?? '').includes(
            REPLAY_MARKER
          ),
        },
        [
          `${s2} → ${obs.resumed?.sessionId}`,
          `DELTA review ${review?.agentId ?? 'none'}: ${flat(updatePart(review?.prompt ?? ''), 200)}`,
        ]
      );
    },
  },
  {
    id: 'l3-session-branch',
    title: '/branch gives a new session id, ends the old one with reason resume, and keeps the on flag',
    source: SESSION,
    kind: 'deterministic',
    scenario: 'l3-session',
    needs: [],
    verify: (obs) => {
      const s3 = obs.branched?.sessionId ?? null;
      const ends = sessionEnds(obs.events).filter((end) => end.t >= (obs.branch?.at ?? Number.POSITIVE_INFINITY));
      return expectAll(
        {
          '/branch ran': obs.branch?.ok === true,
          'a new session id after /branch': s3 !== null && s3 !== obs.s1 && s3 !== obs.cleared?.sessionId,
          [ON_KEPT]: isOnReply(obs.branched),
          'session.end with reason resume on the branched id': ends.some(
            (end) => end.reason === 'resume' && end.sessionId === obs.resumed?.sessionId
          ),
        },
        [`${obs.resumed?.sessionId} → ${s3}`, `session.end after /branch: ${ends.map((end) => end.reason).join(', ')}`]
      );
    },
  },
  {
    id: 'l3-session-rewind',
    title: 'A /rewind restore keeps the session id, and the next review starts with the rewind marker',
    source: SESSION,
    kind: 'deterministic',
    scenario: 'l3-session',
    needs: [],
    verify: (obs) => {
      const rewind = obs.rewind ?? {};
      const stage = ['opened', 'picked', 'closed', 'restored'].find((key) => rewind[key] !== true);
      if (stage !== undefined) {
        return inconclusive([
          `the probe could not drive the /rewind picker: step "${stage}" did not happen`,
          `command.run rewind ${rewind.commandRun}; selected ${clip(String(rewind.selected), 80)}; ` +
            `choice ${rewind.choice}`,
          `picker: ${flat(pickerLines(rewind.picker ?? '').join(' '), 200)}`,
          `after: ${flat(
            String(rewind.after ?? '')
              .split('\n')
              .slice(-12)
              .join(' '),
            200
          )}`,
        ]);
      }
      const turn = turnOf(obs.events, 'CHARLIE');
      const review = reviewSpawns(obs.events).find(
        (spawn) => spawn.t >= (obs.charlie?.at ?? 0) && spawn.t < (obs.clear?.at ?? Number.POSITIVE_INFINITY)
      );
      return expectAll(
        {
          'the restore kept the session id': turn?.end?.sessionId === obs.s1,
          'the CHARLIE review starts its update with the rewind marker': updatePart(review?.prompt ?? '').includes(
            REWIND_MARKER
          ),
        },
        [
          `command.run rewind when the picker opened: ${rewind.commandRun}; restore item: ${rewind.choice ?? 'none'}`,
          `prompt box empty after the restore: ${rewind.isInputEmpty}`,
          `CHARLIE review ${review?.agentId ?? 'none'}: ${flat(updatePart(review?.prompt ?? ''), 200)}`,
        ]
      );
    },
  },
  {
    id: 'l3-roster-load',
    title: 'A project WATCHDOG.json loads its valid entries and drops a bad key, entry or tool with a warning each',
    source: ROSTER,
    kind: 'deterministic',
    scenario: 'l3-roster',
    needs: [],
    verify: (obs) => {
      const reply = ofEvent(
        obs.events,
        'command.run.out',
        (event) => event.command === 'watchdog' && event.args === 'status'
      )[0];
      const status = String(reply?.text ?? '');
      const warnings = status.split('\n').filter((line) => line.startsWith('warning: '));
      const has = (...parts) => warnings.some((line) => parts.every((part) => line.includes(part)));
      const registers = ofEvent(obs.events, 'agent.register', (event) => event.origin?.plugin === 'watchdog');
      const names = new Set(registers.map((event) => event.name));
      const beta = registers.find((event) => event.name === 'beta');
      const count = `${warnings.length} WATCHDOG.json warnings; see /watchdog status`;
      return expectAll(
        {
          'an unknown key is dropped with a warning': has('unknown key "notAKey"'),
          'a bad top-level maxNotesPerReview is dropped with a warning': has('"maxNotesPerReview"', 'key dropped'),
          'an entry with a wrong type is dropped with a warning': has('watchdog "gamma"', 'watchdog dropped'),
          'a project file grants no WebFetch: the tool is dropped with a warning': has('watchdog "beta"', '"WebFetch"'),
          'each warning names the file ./WATCHDOG.json':
            warnings.length > 0 && warnings.every((line) => line.includes('./WATCHDOG.json')),
          'alpha and beta are registered, gamma is not': names.has('alpha') && names.has('beta') && !names.has('gamma'),
          "beta's registered tools have no WebFetch": beta !== undefined && !(beta.tools ?? []).includes('WebFetch'),
          'the status has a row for alpha and beta with the file': ['alpha', 'beta'].every((name) =>
            new RegExp(`^${name} \\S+(?: · [^\\n]*)? · \\./WATCHDOG\\.json$`, 'mu').test(status)
          ),
          'one log row gives the warning count': logTexts(obs.events, obs.p.events).some((text) =>
            text.includes(count)
          ),
        },
        [
          ...warnings.slice(0, 5).map((line) => clip(line, 200)),
          `registered: ${registers.map((event) => `${event.name} [${(event.tools ?? []).join(' ')}]`).join(', ')}`,
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-subagent-review',
    title: 'An opted-in Explore subagent gets its own review, labeled with its type and agentId in the dump',
    source: SUBAGENT,
    kind: 'deterministic',
    scenario: 'l3-subagent',
    needs: [],
    verify: (obs) => {
      const spawn = ofEvent(obs.events, 'agent.spawn.out', (event) => event.subagentType === 'Explore')[0];
      const exploreId = spawn?.result?.agentId ?? null;
      if (exploreId === null) {
        return inconclusive([
          'the model spawned no Explore subagent',
          `spawns: ${
            ofEvent(obs.events, 'agent.spawn.out')
              .map((event) => event.subagentType)
              .join(', ') || 'none'
          }`,
        ]);
      }
      const prompts = reviewSpawns(obs.events).filter((item) =>
        item.prompt.includes('### Session update: subagent Explore')
      );
      const records = reviewRecords(obs.dumps).filter((record) =>
        record.head.includes(`subagent Explore ${exploreId}`)
      );
      const teammate = ofEvent(obs.events, 'agent.spawn.in', (event) => event.subagentType === 'Explore')[0]
        ?.isTeammate;
      return expectAll(
        {
          'a review prompt has the subagent update part': prompts.length > 0,
          'the dump labels a review "subagent Explore <agentId>"': records.length > 0,
        },
        [
          `Explore ${exploreId} (isTeammate ${teammate}); subagent reviews spawned ${prompts.length}`,
          ...records.slice(0, 2).map((record) => clip(record.head, 200)),
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-subagent-late-note',
    title: 'Each note on the subagent lands in its tool result, or reaches the primary agent with subagent="Explore"',
    source: SUBAGENT,
    kind: 'advisory',
    scenario: 'l3-subagent',
    needs: [],
    verify: (obs) => {
      const notes = noteLog(obs.events).filter((row) => row.subagent === 'Explore' && !row.state.startsWith('dropped'));
      if (notes.length === 0) {
        return inconclusive([`no note on the subagent; note rows ${noteLog(obs.events).length}`]);
      }
      const exploreId = ofEvent(obs.events, 'agent.spawn.out', (event) => event.subagentType === 'Explore')[0]?.result
        ?.agentId;
      const inside = (obs.subagents?.[exploreId] ?? []).map((row) => rowText(row)).join('\n');
      const primary = [
        ...wrapperRows(obs.events).map((row) => String(row.text)),
        ...mainTurnCompletes(obs.events).flatMap((end) => apiMarks(end).map((mark) => mark.replaceAll('\\"', '"'))),
      ]
        .filter((text) => text.includes('subagent="Explore"'))
        .join('\n');
      const routeOf = (head) => {
        if (inside.includes(head)) {
          return 'subagent tool result';
        }
        return primary.includes(head) ? 'primary agent' : null;
      };
      const routes = notes.map((note) => ({ note, route: routeOf(noteHead(note.text)) }));
      const lost = routes.filter((item) => item.route === null);
      return (lost.length === 0 ? pass : fail)([
        ...routes
          .slice(0, 3)
          .map((item) => clip(`${item.note.state} → ${item.route ?? 'not found'}: ${item.note.text}`, 200)),
        `notes on the subagent ${notes.length}; not found in a delivery ${lost.length}`,
        `run: ${obs.run.dir}`,
      ]);
    },
  },
  {
    id: 'l3-headless-route',
    title: 'CLAUDE_WATCHDOG=on turns a -p session on at session.start; it reviews and writes the dump at its end',
    source: HEADLESS,
    kind: 'deterministic',
    scenario: 'headless-review',
    needs: [],
    verify: (obs) => {
      const start = ofEvent(obs.events, 'session.start')[0];
      const prompt = ofEvent(obs.events, 'prompt.submit')[0];
      const registers = ofEvent(obs.events, 'agent.register', (event) => event.origin?.plugin === 'watchdog');
      const dump = dumpTextOf(obs.dumps);
      return expectAll(
        {
          'session.start has isInteractive false': /"isInteractive":false/u.test(String(start?.e ?? '')),
          'the agents registered before the first prompt': registers.some((event) => event.t < (prompt?.t ?? 0)),
          'a review spawned': watchdogSpawns(obs.events).length > 0,
          'the session-end dump names this session': dump.includes(`- session: ${obs.p.sessionId}`),
          'the dump names the on source CLAUDE_WATCHDOG': dump.includes('- on source: CLAUDE_WATCHDOG'),
        },
        [`dumps: ${(obs.dumps ?? []).map((item) => item.file).join(', ') || 'none'}`, `run: ${obs.run.dir}`]
      );
    },
  },
  {
    id: 'l3-headless-prompt',
    title: "In -p, a review prompt holds the person's sdk prompt in full, in its part 2 and its update",
    source: HEADLESS,
    kind: 'deterministic',
    scenario: 'headless-review',
    needs: [],
    verify: (obs) => {
      const first = reviewSpawns(obs.events)[0];
      if (!first) {
        return fail(['no review spawned', `run: ${obs.run.dir}`]);
      }
      const line = first.prompt.split('\n').find((item) => item.includes(REVIEW_PROMPT.slice(0, 40))) ?? 'none';
      const row = ofEvent(obs.events, 'session.append', (event) => !event.agentId && event.door === 'prompt')[0];
      return expectAll(
        {
          '§7.6: the first review has the prompt uncut': first.prompt.includes(REVIEW_PROMPT),
          "§7.7 part 2: it has the person's prompts part": first.prompt.includes(PROMPTS_PART),
        },
        [
          `prompt line in the update: ${clip(line, 200)}`,
          `prompt.submit origin ${JSON.stringify(ofEvent(obs.events, 'prompt.submit')[0]?.origin)}; ` +
            `session.append origin ${JSON.stringify(row?.origin)}`,
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-nested-unset',
    title: 'A Bash child of a CLAUDE_WATCHDOG=on run sees the variable unset',
    source: HEADLESS,
    kind: 'deterministic',
    scenario: 'l3-roster',
    needs: [],
    verify: (obs) => {
      const printed = [...toolResultText(obs.p.events).matchAll(/WD=(\S*)/gu)].map((match) => match[1]);
      if (printed.length === 0) {
        return inconclusive(['the model did not run the echo command', flat(assistantText(obs.p.events), 160)]);
      }
      return printed.every((value) => value === 'unset' || value === '')
        ? pass([`the Bash child printed: ${printed.map((value) => `WD=${value}`).join(', ')}`])
        : fail([`the Bash child still sees CLAUDE_WATCHDOG: ${printed.map((value) => `WD=${value}`).join(', ')}`]);
    },
  },
  {
    id: 'l3-project-env-deny',
    title: 'A project env.CLAUDE_WATCHDOG is ignored: the session stays off and the dump warns',
    source: HEADLESS,
    kind: 'deterministic',
    scenario: 'l3-project-env',
    needs: [],
    verify: (obs) => {
      const status = ofEvent(obs.events, 'command.run.out', (event) => event.command === 'watchdog')[0];
      const dump = dumpTextOf(obs.dumps);
      return expectAll(
        {
          'the status reads "watchdog off"': String(status?.text ?? '').startsWith('watchdog off'),
          'the plugin registered no agent':
            ofEvent(obs.events, 'agent.register', (e) => e.origin?.plugin === 'watchdog').length === 0,
          'no review spawned': watchdogSpawns(obs.events).length === 0,
          'the session-end dump has the project env warning': dump.includes(`- warning: ${ENV_DENY}`),
          'the dump names no on source': dump.includes('- on source: none (off)'),
        },
        [
          `status: ${flat(status?.text, 120)}`,
          flat(
            dump.split('\n').find((line) => line.includes('CLAUDE_WATCHDOG')) ?? 'no CLAUDE_WATCHDOG line in a dump',
            200
          ),
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
  {
    id: 'l3-limit-state',
    title: 'A real limit row puts the watchdog in limited (no halt), and the next person prompt tries the kept backlog',
    source: FAILURE,
    kind: 'deterministic',
    scenario: 'l3-limit',
    needs: ['account:limit'],
    verify: (obs) => {
      const ids = new Set(reviewSpawns(obs.events).flatMap((spawn) => (spawn.agentId ? [spawn.agentId] : [])));
      const agentRows = ofEvent(
        obs.events,
        'session.append',
        (event) => ids.has(event.agentId) && String(event.text).includes(LIMIT_PHRASE)
      );
      const records = reviewRecords(obs.dumps).filter((record) => String(record.error ?? '').includes(LIMIT_PHRASE));
      if (agentRows.length === 0 && records.length === 0) {
        return inconclusive([`no review got "${LIMIT_PHRASE}": the account is not at its limit now`]);
      }
      const logs = logTexts(obs.events, obs.p.events);
      const second = ofEvent(
        obs.events,
        'prompt.submit',
        (event) => !event.agentId && String(event.text).includes('WDLIMIT2')
      )[0];
      const tries = reviewSpawns(obs.events).filter((spawn) => second && spawn.t >= second.t);
      return expectAll(
        {
          'one row "watchdog: <name> limited: <limit text>"': logs.some(
            (text) => /^watchdog: \S+ limited: /u.test(text) && text.includes(LIMIT_PHRASE)
          ),
          'the limit does not halt the watchdog': !logs.some((text) => /^watchdog: \S+ halted/u.test(text)),
          'the dump keeps the limit error': records.length > 0,
          'the next person prompt tries one review': tries.length > 0,
          "that review's update holds the kept WDLIMIT1 update": tries.some((spawn) =>
            updatePart(spawn.prompt).includes('WDLIMIT1')
          ),
        },
        [
          ...logs
            .filter((text) => text.startsWith('watchdog: '))
            .slice(0, 3)
            .map((text) => clip(text, 200)),
          `run: ${obs.run.dir}`,
        ]
      );
    },
  },
];

export const scenarios = [sessionChanges, rosterSession, subagentReview, projectEnvDeny, limitState];
