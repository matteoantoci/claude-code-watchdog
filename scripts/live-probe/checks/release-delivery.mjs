// §16.5 release-probe items of the delivery group: the note wrapper and delivery text, late subagent notes, queue
// order and time, the cache cost of an append, compaction and the session id, a $.ui.log row over 4096 characters,
// the headless dump, and the UI items (the digit hotkey of a second band card, fork usage in /cost, the ctrl+o
// transcript view). Each claim is [INFERENCE] in the spec, so a check is advisory unless the probe forces the
// action and the plugin depends on the fact. The Desktop half of the UI item is in manual.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR, sleep } from '../lib/env.mjs';
import { dumpReviews, readTranscript, rowText, subagentTranscripts } from '../lib/files.mjs';
import { pluginDirs, runHeadless } from '../lib/headless.mjs';
import { agentTurnCompletes, mainTurnCompletes, ofEvent, readObs, waitObs, watchdogAgentIds } from '../lib/observe.mjs';
import { startProxy } from '../lib/proxy-ctl.mjs';
import { createRun, readJsonLines, readText } from '../lib/run.mjs';
import { BUSY, READY, startTui } from '../lib/tui.mjs';
import { clip, expectAll, fail, inconclusive, pass } from '../lib/verdict.mjs';

// rd-steer: a long reply with no tool, so the append lands while it streams; then a follow-up that invites a check
// without naming a file.
const STEER_LIST = 'Do not use tools. Write the integers from 1 to 120, one number per line, and nothing else.';
const STEER_FOLLOW =
  'Before we go on: in at most two lines, say whether anything in this conversation needs a check or a fix. ' +
  'You may use the Read tool.';
// research/smoke-framing.md:430: one note names a checkable fact (a file, a line, a value), one names none.
const FACT_NOTE = 'math.js line 2: add returns a - b, so add(2, 3) gives -1, not 5.';
const VAGUE_NOTE = 'Be more careful in general.';
const WRAPPER = '<watchdog-notes>';

// rd-sub: research/smoke-subagent-delivery.md case 1 (a Bash call in flight, then a second one that shows what the
// agent read). The marks are the texts of the mod's notes (mods/rd-sub).
const SUB_TASK = [
  'Use the Agent tool exactly once, with subagent_type general-purpose and run_in_background false.',
  'Give the agent this task, word for word: "1. Run the Bash command: sleep 4; echo step1',
  '2. Run the Bash command: echo step2 SEEN=WORD, where WORD is the code word of any watchdog note you got after',
  'step 1, else NONE. 3. Reply with exactly AGENT_SAW=WORD." When the agent returns, reply with exactly',
  'PARENT_SAW=<the WORD in its report>. Use no other tool.',
].join(' ');
const INFLIGHT_MARK = 'Code word RDINFLIGHT';
const LATE_MARK = 'Late code word RDLATE';
const RESUME_MARK = 'RDRESUME';
const SLEEP = /sleep\s+\d/u;

// rd-tui: research/smoke-aside-nudge.md (a reply long enough to type into, a queued prompt, a held turn.complete).
const LONG_REPLY = 'Do not use tools. Write the integers from 1 to 200, one number per line, and nothing else.';
const LONG_MARK = 'integers from 1 to 200';
const QUEUED = 'Reply with exactly QUEUED=PAPA. Do not use tools.';
const QUEUED_MARK = 'QUEUED=PAPA';
const HOLD_PROMPT = 'RDHOLD: reply with exactly HOLD=ONE. Do not use tools.';
const AFTER_PROMPT = 'Reply with exactly AFTER=TWO. Do not use tools.';
const AFTER_MARK = 'AFTER=TWO';
const AFTER_COMPACT = 'Reply with exactly COMPACTED=OK. Do not use tools.';
const NOTE_MARK = 'RDNOTE-CTRLO';
// The label of the ctrl+o view on 2.1.290 (the binary's "Showing detailed transcript").
const TRANSCRIPT_VIEW = /detailed transcript/iu;
// The /cost (/usage) dialog: its session section (`Total cost`, `Usage by model`) or its plan rows (`% used`).
const COST_PANE = /Total cost|Usage by model|Session|% used/u;
// No tool prompt may stop the TUI: the prompts ask for no tool, and these are denied outright.
const TUI_DENY = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent';
// plugins/watchdog/hooks/prices.ts: Haiku 4.5, USD for each million tokens; the probe sessions run on haiku.
const HAIKU_PRICE = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

// Polls `test` once a second until it holds or `timeoutMs` passes; resolves its last value.
const until = async (test, timeoutMs) => {
  const begin = Date.now();
  while (!test() && Date.now() - begin < timeoutMs) {
    await sleep(1000);
  }
  return test();
};

const readJson = (file) => {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
};

// The block types of a transcript row (a string content is one text block).
const blockTypes = (row) => {
  const content = row?.message?.content;
  const list = Array.isArray(content) ? content : content ? [content] : [];
  return list.map((block) => (typeof block === 'string' ? 'text' : (block?.type ?? '?')));
};

const isThinking = (row) => blockTypes(row).some((type) => type === 'thinking' || type === 'redacted_thinking');

// The uuids from a transcript row up its parentUuid chain.
const ancestorsOf = (rows, row) => {
  const byId = new Map(rows.filter((item) => item.uuid).map((item) => [item.uuid, item]));
  const seen = new Set();
  for (let cursor = row; cursor && !seen.has(cursor.uuid); cursor = byId.get(cursor.parentUuid)) {
    seen.add(cursor.uuid);
  }
  return seen;
};

const promptIndex = (rows, text) => rows.findIndex((row) => row.type === 'user' && rowText(row).includes(text));

// The observer clips a ui.log text at 2000 characters and writes `…(+N)` for the rest (mods/observer).
const seenLength = (event) => {
  if (!event) {
    return null;
  }
  const extra = String(event.text).match(/…\(\+(\d+)\)$/u);
  return extra ? 2000 + Number(extra[1]) : String(event.text).length;
};

// research/smoke-framing.md:211: a sentence that speaks to the watchdog, not one that mentions its note.
const addressesWatchdog = (text) =>
  String(text)
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => /watchdog/iu.test(sentence))
    .filter(
      (sentence) =>
        /watchdog\s*[,:]/iu.test(sentence) ||
        /\b(dear|hey|thanks?,?)\s+watchdog\b/iu.test(sentence) ||
        /\b(reply|respond|answer|tell)(?:ing)?\s+(?:to\s+)?(?:the\s+)?watchdog\b/iu.test(sentence)
    );

// §15: the USD of one usage at haiku prices, null without usage.
const haikuUsd = (usage) =>
  usage
    ? (usage.input_tokens * HAIKU_PRICE.input +
        usage.output_tokens * HAIKU_PRICE.output +
        usage.cache_read_input_tokens * HAIKU_PRICE.cacheRead +
        usage.cache_creation_input_tokens * HAIKU_PRICE.cacheWrite) /
      1_000_000
    : null;

const usd = (value) => (typeof value === 'number' ? `$${value.toFixed(6)}` : String(value));

// §13.2, §16.5 $.ui.log: a -p session whose mod logs a 5000- and a 10000-character row in session.start.
const rdUilog = {
  id: 'rd-uilog',
  title: 'Headless: $.ui.log rows of 5000 and 10000 characters in session.start',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'rd-uilog');
    const p = await runHeadless(run, {
      label: 'p',
      prompt: 'Reply with exactly OK. Do not use tools.',
      plugins: pluginDirs(run, { watchdog: false, mods: ['rd-uilog'] }),
      timeoutMs: 120_000,
    });
    await sleep(500);
    return { run, p, events: readObs(run), uilog: readJson(path.join(run.logs, 'rd-uilog.json')) };
  },
};

// §10.7: the wrapper of every route with the shipped boundary guidance, as the steer appends it (§10.1).
const steerNote = () =>
  [
    WRAPPER,
    fs.readFileSync(path.join(PLUGIN_DIR, 'prompts/boundary-guidance.md'), 'utf8').trim(),
    `<note watchdog="probe" severity="concern">${FACT_NOTE}</note>`,
    `<note watchdog="probe" severity="nit">${VAGUE_NOTE}</note>`,
    '</watchdog-notes>',
  ].join('\n');

// §16.5 note wrapper and delivery text, cache cost of an append: research/smoke-steer.md Q1 without a thinking
// block. The mod appends the note while the first reply streams; the second prompt shows what the model does.
const rdSteer = {
  id: 'rd-steer',
  title: 'Headless, thinking off: a wrapped note appended while the first reply streams, then a follow-up prompt',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'rd-steer');
    fs.writeFileSync(path.join(run.dir, 'rd-steer-note.txt'), steerNote());
    const p = await runHeadless(run, {
      label: 'p',
      plugins: pluginDirs(run, { watchdog: false, mods: ['rd-steer'] }),
      // smoke-steer.md:349 needs a reply with no thinking block; 2.1.290 reads both switches.
      env: { MAX_THINKING_TOKENS: '0' },
      args: ['--settings', JSON.stringify({ alwaysThinkingEnabled: false }), '--allowedTools', 'Read'],
      input: async (send) => {
        send(STEER_LIST);
        await until(() => mainTurnCompletes(readObs(run)).length >= 1, 120_000);
        send(STEER_FOLLOW);
        await until(() => mainTurnCompletes(readObs(run)).length >= 2, 120_000);
      },
      closeAfterMs: 5_000,
      timeoutMs: 300_000,
    });
    await sleep(1000);
    return {
      run,
      p,
      events: readObs(run),
      transcript: readTranscript(p.sessionId),
      steerLog: readJsonLines(path.join(run.logs, 'rd-steer.jsonl')),
    };
  },
};

// The first wait of rd-sub is over once the mod sent its resume, or once the main loop has been idle for 10 s after
// its last turn (and after the agent's run, when the model called the Agent tool) with no resume sent.
const subSettled = (run, logFile) => {
  if (readJsonLines(logFile).some((row) => row.kind === 'resume')) {
    return true;
  }
  const events = readObs(run);
  const last = mainTurnCompletes(events).at(-1);
  const isCalled = ofEvent(events, 'tool.call.in', (event) => event.tool === 'Agent').length > 0;
  const agentEnd = ofEvent(events, 'turn.complete', (event) => event.agentId).at(-1);
  const isIdle = Boolean(last) && (!isCalled || (agentEnd && last.t > agentEnd.t));
  return isIdle && Date.now() - last.t > 10_000;
};

// The second wait: the resumed run ended, or the resume was not delivered.
const resumeSettled = (logFile) => {
  const log = readJsonLines(logFile);
  const resume = log.find((row) => row.kind === 'resume');
  return !resume || resume.outcome !== 'delivered' || log.some((row) => row.kind === 'complete' && row.run >= 2);
};

// §16.5 late subagent notes, through the proxy so each request of the agent is on file: the mod appends a note
// while the agent's sleep Bash call runs, one after its answer, one at its turn.complete, then resumes it.
const rdSub = {
  id: 'rd-sub',
  title: 'Headless, through the proxy: notes into a subagent during a Bash call and after its answer, then a resume',
  needs: ['proxy'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rd-sub');
    const logFile = path.join(run.logs, 'rd-sub.jsonl');
    const proxy = await startProxy(run, { saveBodies: true });
    try {
      const p = await runHeadless(run, {
        label: 'p',
        plugins: pluginDirs(run, { watchdog: false, mods: ['rd-sub'] }),
        env: proxy.env,
        args: ['--allowedTools', 'Agent,Bash'],
        input: async (send) => {
          send(SUB_TASK);
          await until(() => subSettled(run, logFile), 180_000);
          await until(() => resumeSettled(logFile), 90_000);
        },
        closeAfterMs: 5_000,
        timeoutMs: 330_000,
      });
      await sleep(1000);
      return {
        run,
        p,
        events: readObs(run),
        subLog: readJsonLines(logFile),
        bodies: proxy.bodies(),
        subagents: subagentTranscripts(p.sessionId),
      };
    } finally {
      proxy.stop();
    }
  },
};

// The pane is back at the prompt and `hidden` is gone from it; an Escape closes a dialog that is still up.
const backToPrompt = async (tui, hidden = null) => {
  const isBack = (text) => READY.test(text) && !hidden?.test(text);
  const back = await tui.waitFor(isBack, { timeoutMs: 5_000 });
  if (!back.ok) {
    await tui.keys('Escape');
    await tui.waitFor(isBack, { timeoutMs: 5_000 });
  }
};

// The first observer event `ev` after `from` that `test` passes, polled for up to `timeoutMs`.
const waitEvent = (run, ev, from, test, timeoutMs) =>
  waitObs(run, (events) => ofEvent(events, ev, (event) => event.t > from && test(event))[0], { timeoutMs });

const hasRow = (file, kind) => readJsonLines(file).some((row) => row.kind === kind);

// §16.5 queue order and time, compaction, UI: one TUI session, steps in this order so that no step's model work
// overlaps another's measurement. Every wait is bounded; a step that times out leaves its check inconclusive.
const rdTui = {
  id: 'rd-tui',
  title: 'TUI: a prompt typed during a reply, the digit hotkey, a held turn.complete, a fork, /cost, ctrl+o, /compact',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rd-tui');
    const queueLog = path.join(run.logs, 'rd-queue.jsonl');
    const bandLog = path.join(run.logs, 'rd-band.jsonl');
    const tui = await startTui(run, {
      label: 'tui',
      plugins: pluginDirs(run, { watchdog: false, mods: ['rd-band', 'rd-queue'] }),
      args: ['--disallowedTools', TUI_DENY],
    });
    const screens = {};
    const steps = {};
    const mainTurns = () => mainTurnCompletes(readObs(run)).length;
    try {
      // smoke-aside-nudge.md:398: the second prompt is typed while the first reply streams, then sent.
      await tui.type(LONG_REPLY);
      await tui.type(QUEUED, { enter: false });
      const busy = await tui.waitFor(BUSY, { timeoutMs: 30_000, intervalMs: 250 });
      await tui.keys('Enter');
      steps.typedDuring = busy.ok;
      screens.queued = tui.capture('queued');
      await waitObs(run, (events) => mainTurnCompletes(events).length >= 1, { timeoutMs: 120_000 });
      await tui.waitIdle({ timeoutMs: 90_000 });
      await waitObs(run, (events) => mainTurnCompletes(events).length >= 2, { timeoutMs: 15_000 });
      // you-should-know.md:135: a bare digit in the empty composer presses a band Button.
      const isBand = (text) => text.includes('RDCARD-A') && text.includes('RDCARD-B');
      steps.cards = (await tui.waitFor(isBand, { timeoutMs: 15_000 })).ok;
      await tui.keys('2');
      await sleep(1000);
      screens.hotkey = tui.capture('hotkey', { ansi: true });
      await tui.keys('C-u');
      // smoke-aside-nudge.md:267: the mod holds the RDHOLD turn's turn.complete; the next prompt goes in meanwhile.
      const beforeHold = mainTurns();
      await tui.type(HOLD_PROMPT);
      steps.held = await until(() => hasRow(queueLog, 'hold-start'), 60_000);
      if (steps.held) {
        await sleep(1000);
        await tui.type(AFTER_PROMPT);
        await until(() => hasRow(queueLog, 'hold-end'), 20_000);
      }
      const heldTurns = beforeHold + (steps.held ? 2 : 1);
      await waitObs(run, (events) => mainTurnCompletes(events).length >= heldTurns, { timeoutMs: 60_000 });
      await tui.waitIdle({ timeoutMs: 60_000 });
      screens.held = tui.capture('held');
      // you-should-know.md:61,136: the /cost ledger around one fork, then /cost itself (its dialog closes on Esc).
      await tui.type('/rdprobe fork');
      steps.fork = await until(() => hasRow(bandLog, 'fork'), 90_000);
      await sleep(800);
      screens.fork = tui.capture('fork');
      const costFrom = Date.now();
      await tui.type('/cost');
      await tui.waitFor(COST_PANE, { timeoutMs: 20_000 });
      await sleep(1000);
      screens.cost = tui.capture('cost', { ansi: true });
      await tui.keys('Escape');
      await waitEvent(run, 'command.run.out', costFrom, () => true, 10_000);
      await backToPrompt(tui);
      // issues/11-ui-prototype.md:37: a $.ui.log row in the watchdog's format, then the ctrl+o transcript view.
      const noteFrom = Date.now();
      await tui.type('/rdprobe note');
      const isNote = (event) => String(event.text).includes(NOTE_MARK);
      steps.noteSent = (await waitEvent(run, 'ui.log', noteFrom, isNote, 10_000)).ok;
      await sleep(800);
      screens.note = tui.capture('note');
      await tui.keys('C-o');
      await tui.waitFor(TRANSCRIPT_VIEW, { timeoutMs: 5_000 });
      await sleep(800);
      screens.ctrlo = tui.capture('ctrlo', { ansi: true });
      await tui.keys('C-o');
      await backToPrompt(tui, TRANSCRIPT_VIEW);
      // research/transcript.md:111: /compact, then one more turn, so the id is read after the compaction too. An
      // Enter more when the typeahead took the first one.
      const compactFrom = Date.now();
      const isCompact = (event) => event.command === 'compact';
      await tui.type('/compact');
      if (!(await waitEvent(run, 'command.run.in', compactFrom, isCompact, 6_000)).ok) {
        await tui.keys('Enter');
      }
      steps.compacted = (await waitEvent(run, 'command.run.out', compactFrom, isCompact, 150_000)).ok;
      await sleep(1500);
      screens.compact = tui.capture('compact', { ansi: true });
      await tui.waitIdle({ timeoutMs: 60_000 });
      const beforeLast = mainTurns();
      await tui.type(AFTER_COMPACT);
      await waitObs(run, (events) => mainTurnCompletes(events).length > beforeLast, { timeoutMs: 60_000 });
      screens.last = tui.capture('after-compact');
      const events = readObs(run);
      const sessionId = ofEvent(events, 'session.start')[0]?.sessionId ?? null;
      return {
        run,
        screens,
        steps,
        events,
        sessionId,
        transcript: readTranscript(sessionId),
        queueLog: readJsonLines(queueLog),
        bandLog: readJsonLines(bandLog),
      };
    } finally {
      await tui.stop();
    }
  },
};

// §16.5 $.ui.log: 2.1.289 refused a row over 4096 characters; the 2.1.290 d.ts takes any length. A refusal would
// make the plugin's own row call reject, so this is wiring the plugin depends on.
const verifyUilog = (obs) => {
  const rows = obs.uilog?.rows ?? [];
  const outcome = (len) => rows.find((item) => item.len === len)?.outcome ?? 'none';
  const seen = (prefix) =>
    seenLength(ofEvent(obs.events, 'ui.log', (event) => String(event.text).startsWith(prefix))[0]);
  const isTaken = (len, prefix) => outcome(len) === 'ok' && seen(prefix) !== null;
  return expectAll(
    {
      'a 5000-character $.ui.log row resolves and reaches the ui.log hooks': isTaken(5000, 'RDLOG5 '),
      'a 10000-character $.ui.log row resolves and reaches the ui.log hooks': isTaken(10000, 'RDLOGA '),
    },
    [
      `mod outcomes 5000=${outcome(5000)} 10000=${outcome(10000)}`,
      `length the hooks got 5000=${seen('RDLOG5 ')} 10000=${seen('RDLOGA ')}`,
      `status ${path.join(obs.run.logs, 'rd-uilog.json')}`,
    ]
  );
};

// The append the mod made in rd-steer, and whether its call came before the first reply's stream ended.
const steerAppend = (obs) => {
  const log = obs.steerLog ?? [];
  const append = log.find((row) => row.kind === 'append');
  const isEnd = (row) => row.kind === 'step' && row.turnId === append?.turnId && row.index === append?.index;
  const end = append ? log.find(isEnd) : null;
  return { append, isDuring: Boolean(append && end && append.calledAt < end.t) };
};

// The main turn.complete of one turn.
const turnEnd = (events, turnId) =>
  ofEvent(events, 'turn.complete', (event) => !event.agentId && event.turnId === turnId)[0] ?? null;

// research/smoke-steer.md:349: with no thinking block, the note row comes before the whole text reply.
const verifyNoteOrder = (obs) => {
  const rows = obs.transcript ?? [];
  const { append, isDuring } = steerAppend(obs);
  const note = rows.find((row) => rowText(row).includes(WRAPPER));
  const first = promptIndex(rows, STEER_LIST);
  const second = promptIndex(rows, STEER_FOLLOW);
  const reply = rows.slice(first + 1, second < 0 ? undefined : second).filter((row) => row.type === 'assistant');
  const texts = reply.filter((row) => blockTypes(row).includes('text'));
  const parent = note ? rows.find((row) => row.uuid === note.parentUuid) : null;
  const marks = mainTurnCompletes(obs.events).at(-1)?.notes?.marks ?? [];
  const evidence = [
    `append ${append?.outcome ?? 'none'}, called while the reply streamed ${isDuring}`,
    `note row ${Boolean(note)}, its parent ${parent ? `${parent.type}:${blockTypes(parent).join(',')}` : 'none'}`,
    `first reply rows ${reply.map((row) => blockTypes(row).join(',')).join(' | ') || 'none'}`,
    `API view at the last turn.complete: notes at ${marks.map((mark) => `#${mark.index} ${mark.role}`).join(', ')}`,
  ];
  if (append?.outcome !== 'ok' || !isDuring) {
    return inconclusive([...evidence, 'no append went in while the first reply streamed']);
  }
  if (reply.some(isThinking)) {
    return inconclusive([...evidence, 'the reply had a thinking block, so this is not the no-thinking case']);
  }
  if (!note || texts.length === 0) {
    return inconclusive([...evidence, 'the transcript has no note row or no text reply']);
  }
  return texts.every((row) => ancestorsOf(rows, row).has(note.uuid))
    ? pass([...evidence, 'the note row is an ancestor of every text row of the reply'])
    : fail([...evidence, 'a text row of the reply comes before the note row']);
};

// The follow-up turn of rd-steer, by its prompt.
const followTurn = (obs) => {
  const start = ofEvent(obs.events, 'turn.start', (event) => String(event.text).includes(STEER_FOLLOW.slice(0, 40)))[0];
  return { start, done: start ? turnEnd(obs.events, start.turnId) : null };
};

const noteLanded = (obs) =>
  steerAppend(obs).append?.outcome === 'ok' && (obs.transcript ?? []).some((row) => rowText(row).includes(WRAPPER));

// research/smoke-framing.md:211: with the shipped wrapper (no "Do not reply to the watchdog." line, §10.7) the reply
// does not speak to the watchdog. The research saw it on sonnet; the probe runs haiku.
const verifyAddress = (obs) => {
  const { done } = followTurn(obs);
  if (!noteLanded(obs)) {
    return inconclusive(['the note never landed, so no reply could address the watchdog']);
  }
  if (!done) {
    return inconclusive(['the follow-up turn did not complete']);
  }
  const answer = String(done.answer ?? '');
  const hits = addressesWatchdog(answer);
  const evidence = [`mentions the watchdog ${/watchdog/iu.test(answer)}`, `answer ${clip(answer, 240)}`];
  return hits.length > 0
    ? fail([`addresses the watchdog: ${clip(hits[0], 160)}`, ...evidence])
    : pass(['does not address the watchdog', ...evidence]);
};

// research/smoke-framing.md:430: the note with a checkable fact (a file and a line) gets checked or used; the
// note with none may get nothing.
const verifyFact = (obs) => {
  const { start, done } = followTurn(obs);
  if (!noteLanded(obs)) {
    return inconclusive(['the note never landed, so neither note could be acted on']);
  }
  if (!start || !done) {
    return inconclusive(['the follow-up turn did not complete']);
  }
  const answer = String(done.answer ?? '');
  const reads = ofEvent(
    obs.events,
    'tool.call.in',
    (event) => !event.agentId && event.tool === 'Read' && String(event.input).includes('math.js') && event.t >= start.t
  );
  const isUsed = /a\s*-\s*b|subtract/iu.test(answer);
  const evidence = [
    `checkable note: Read math.js ${reads.length}, answer uses its fact ${isUsed}`,
    `vague note taken up ${/careful/iu.test(answer)}`,
    `answer ${clip(answer, 240)}`,
  ];
  return reads.length > 0 || isUsed
    ? pass(evidence)
    : fail([...evidence, 'the checkable fact was delivered and neither checked nor used']);
};

// research/smoke-steer.md:350 (cache cost of an append, not measured): the request after the append reads from
// the cache at least what the request before it had cached, when the append kept the cached prefix.
const verifyCache = (obs) => {
  const { append, isDuring } = steerAppend(obs);
  const steps = (obs.steerLog ?? []).filter((row) => row.kind === 'step' && row.usage);
  const before = append ? steps.find((row) => row.turnId === append.turnId) : null;
  const after = before ? steps.find((row) => row.t > before.t && row.turnId !== before.turnId) : null;
  const counts = (row) => {
    const usage = row?.usage;
    return usage
      ? `input ${usage.input_tokens} read ${usage.cache_read_input_tokens} write ${usage.cache_creation_input_tokens}`
      : 'none';
  };
  const evidence = [
    `append ${append?.outcome ?? 'none'}, while the reply streamed ${isDuring}`,
    `request before: ${counts(before)}`,
    `first request after: ${counts(after)}`,
  ];
  if (append?.outcome !== 'ok' || !before || !after) {
    return inconclusive([...evidence, 'no append, or no usage of the requests around it']);
  }
  const cached = before.usage.cache_read_input_tokens + before.usage.cache_creation_input_tokens;
  const read = after.usage.cache_read_input_tokens;
  const line = `cached before ${cached}, read after ${read}, written after ${after.usage.cache_creation_input_tokens}`;
  return read >= cached * 0.98
    ? pass([...evidence, line, 'the append kept the cached prefix'])
    : fail([...evidence, line, 'the append cost the cached prefix: the request after it wrote the cache again']);
};

// The agent's requests on the wire (mods/rd-sub): no Agent call in their history, and the agent's sleep Bash call.
const agentRequests = (bodies) =>
  (bodies ?? [])
    .map(({ id, body }) => {
      const uses = (body?.messages ?? [])
        .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
        .filter((block) => block?.type === 'tool_use');
      return { id, uses, text: JSON.stringify(body?.messages ?? []) };
    })
    .filter(
      ({ uses }) =>
        !uses.some((use) => use.name === 'Agent' || use.name === 'Task') &&
        uses.some((use) => use.name === 'Bash' && SLEEP.test(String(use.input?.command ?? '')))
    );

// research/smoke-subagent-delivery.md:225: a note appended while the agent's tool call runs reaches its next
// request; once the model answers with no tool use, the run ends, so a note appended then is never sent.
const verifyInflight = (obs) => {
  const log = obs.subLog ?? [];
  const inflight = log.find((row) => row.kind === 'inflight');
  if (!inflight) {
    const why = 'the agent ran no sleep Bash call, so no note went in during a tool call';
    return inconclusive([why, `log ${clip(log)}`]);
  }
  const late = log.find((row) => row.kind === 'late-step');
  const atEnd = log.find((row) => row.kind === 'late-complete');
  const resume = log.find((row) => row.kind === 'resume');
  const firstRun = agentRequests(obs.bodies).filter((item) => !item.text.includes(RESUME_MARK));
  const isLanded = firstRun.some((item) => item.text.includes(INFLIGHT_MARK));
  const stepsAfter = late
    ? ofEvent(
        obs.events,
        'turn.step',
        (event) => event.agentId === inflight.agentId && event.t > late.t && event.t < (resume?.t ?? Infinity)
      )
    : [];
  const lateSent = firstRun.filter((item) => item.text.includes(LATE_MARK));
  const answer = log.find((row) => row.kind === 'complete' && row.run === 1)?.answer ?? '';
  const evidence = [
    `in flight: append ${inflight.outcome}; in a later request of the agent ${isLanded} (${firstRun.length} requests)`,
    `after the answer: append ${late?.outcome ?? 'none'}, later steps ${stepsAfter.length}, ` +
      `requests with it ${lateSent.length}`,
    `at the agent's turn.complete: append ${atEnd?.outcome ?? 'none'}`,
    `agent answer ${clip(answer, 120)} (acted on the note ${/RDINFLIGHT/u.test(answer)})`,
    `bodies ${path.join(obs.run.dir, 'proxy', 'req')}`,
  ];
  if (inflight.outcome !== 'ok') {
    return fail([...evidence, 'the append while the Bash call ran was refused']);
  }
  if (firstRun.length === 0) {
    return inconclusive([...evidence, 'the proxy saved no request of the agent after its Bash call']);
  }
  if (!isLanded) {
    return fail([...evidence, 'the note appended while the Bash call ran is in no later request of the agent']);
  }
  if (!late) {
    return inconclusive([...evidence, 'the agent run did not end with an answer, so no note went in after it']);
  }
  return stepsAfter.length > 0 || lateSent.length > 0
    ? fail([...evidence, 'a request followed the note appended after the answer'])
    : pass([...evidence, 'the in-flight note reached the next request; after the answer no request followed']);
};

// research/smoke-subagent-delivery.md:142: the appended row sits on a side branch of the agent's JSONL (its parent
// is the tool_use row, as the tool_result's is), so a resume that walks the chain from the leaf drops it.
const verifyResume = (obs) => {
  const log = obs.subLog ?? [];
  const inflight = log.find((row) => row.kind === 'inflight');
  const resume = log.find((row) => row.kind === 'resume');
  if (!inflight || inflight.outcome !== 'ok') {
    return inconclusive(['no note went into the agent, so a resume could not drop one', `log ${clip(log)}`]);
  }
  if (!resume) {
    return inconclusive(['no resume was sent: the agent run or the main turn after it did not end']);
  }
  if (resume.outcome !== 'delivered') {
    return inconclusive([`the resume was not delivered: ${clip(resume.outcome)}`]);
  }
  const resumed = agentRequests(obs.bodies).filter((item) => item.text.includes(RESUME_MARK));
  const rows = obs.subagents?.[inflight.agentId] ?? [];
  const note = rows.find((row) => rowText(row).includes(INFLIGHT_MARK));
  const siblings = note ? rows.filter((row) => row.uuid !== note.uuid && row.parentUuid === note.parentUuid) : [];
  const isOnChain = note && rows.length > 0 ? ancestorsOf(rows, rows.at(-1)).has(note.uuid) : null;
  const answer = log.find((row) => row.kind === 'complete' && row.run >= 2)?.answer ?? '';
  const beside = siblings.map((row) => blockTypes(row).join(',')).join(' | ') || 'none';
  const evidence = [
    `JSONL: note row ${Boolean(note)}, rows beside it ${beside}, on the leaf chain ${isOnChain}`,
    `resumed answer ${clip(answer, 120)}`,
  ];
  if (resumed.length === 0) {
    return inconclusive([...evidence, 'the proxy saw no request of the resumed agent']);
  }
  const head = resumed[0];
  const has = (mark) => head.text.includes(mark);
  evidence.unshift(`resumed request ${head.id}: in-flight note ${has(INFLIGHT_MARK)}, late note ${has(LATE_MARK)}`);
  return head.text.includes(INFLIGHT_MARK)
    ? fail([...evidence, 'the resumed agent still had the note appended during its tool call'])
    : pass([...evidence, 'the resume dropped the note appended during its tool call']);
};

// research/smoke-aside-nudge.md:398: a prompt typed during the last reply takes the queue path: its prompt.submit
// fires at Enter with the running turn's id, it is not absorbed, and it starts its own turn with its context.
const verifyTyped = (obs) => {
  const events = obs.events ?? [];
  const startA = ofEvent(events, 'turn.start', (event) => String(event.text).includes(LONG_MARK))[0];
  const doneA = startA ? turnEnd(events, startA.turnId) : null;
  const isQueued = (event) => !event.agentId && String(event.text).includes(QUEUED_MARK);
  const submit = ofEvent(events, 'prompt.submit', isQueued)[0];
  const startB = ofEvent(events, 'turn.start', isQueued)[0];
  const delivered = ofEvent(events, 'session.append', (event) => event.door === 'delivery' && isQueued(event));
  const isContext = (event) => !event.agentId && String(event.text).includes('RDCTX-QUEUED');
  const context = ofEvent(events, 'session.append', isContext)[0];
  const hook = (obs.bandLog ?? []).find((row) => row.kind === 'submit');
  const ops = (obs.transcript ?? [])
    .filter((row) => row.type === 'queue-operation')
    .map((row) => `${row.operation}${row.reason ? `:${row.reason}` : ''}`);
  const isAbsorbed = delivered.length > 0 || String(doneA?.answer ?? '').includes(QUEUED_MARK);
  const isDuring = Boolean(submit && doneA && submit.t < doneA.t);
  const since = (event) => (event && doneA ? ` ${event.t - doneA.t} ms after the reply ended` : '');
  const evidence = [
    `sent during the reply ${isDuring} (busy before Enter ${obs.steps?.typedDuring})`,
    `prompt.submit at Enter: turnId ${hook?.turnId ?? 'none'} (running turn ${startA?.turnId ?? '?'}), ` +
      `origin ${hook?.origin ?? '?'}`,
    `own turn ${Boolean(startB)}${since(startB)}, absorbed ${isAbsorbed}`,
    `context row ${context ? `${context.door}${since(context)}` : 'none'}`,
    `transcript queue ops ${ops.join(' ') || 'none'}`,
  ];
  if (!isDuring) {
    return inconclusive([...evidence, 'the second prompt was not sent while the reply ran']);
  }
  return startB && !isAbsorbed && hook?.turnId
    ? pass([...evidence, 'queued with the running turn id, then its own turn'])
    : fail([...evidence, 'the typed prompt did not take the queue path']);
};

// research/smoke-aside-nudge.md:267 (Q3d): while a plugin's turn.complete hook holds, the next turn runs, and the
// same plugin's turn.start hook for it waits until the held dispatch returns.
const verifyHold = (obs) => {
  const log = obs.queueLog ?? [];
  const start = log.find((row) => row.kind === 'hold-start');
  const end = log.find((row) => row.kind === 'hold-end');
  if (!start || !end) {
    return inconclusive(['the held turn.complete did not run', `log ${clip(log)}`]);
  }
  const submit = log.find((row) => row.kind === 'submit' && String(row.text).includes(AFTER_MARK));
  const after = log.find((row) => row.kind === 'start' && String(row.text).includes(AFTER_MARK));
  const firstStep = after ? log.find((row) => row.kind === 'step' && row.turnId === after.turnId) : null;
  const seen = ofEvent(obs.events, 'turn.start', (event) => String(event.text).includes(AFTER_MARK))[0];
  const at = (row) => (row ? `+${row.t - start.t} ms` : 'none');
  const evidence = [
    `hold ${end.t - start.t} ms; next prompt.submit ${at(submit)}`,
    `its turn.start hook ${at(after)} (${after ? after.t - end.t : '?'} ms after the hold), ` +
      `first turn.step ${at(firstStep)}`,
    `observer turn.start ${at(seen)}`,
  ];
  if (!submit || submit.t > end.t) {
    return inconclusive([...evidence, 'the next prompt was not sent during the hold']);
  }
  if (!after) {
    return inconclusive([...evidence, 'the next turn did not start']);
  }
  if (after.t < end.t) {
    return fail([...evidence, 'the turn.start hook ran while the same plugin still held its turn.complete']);
  }
  return firstStep && firstStep.t < end.t
    ? pass([...evidence, 'the turn ran during the hold, and its turn.start dispatch waited for the held one'])
    : inconclusive([...evidence, 'the turn itself waited for the hold, so the hook order is not told apart']);
};

// research/you-should-know.md:135: of two band Buttons on the same digit, the later one in the tree takes it.
const verifyHotkey = (obs) => {
  const pane = obs.screens?.hotkey ?? '';
  const presses = (obs.bandLog ?? []).filter((row) => row.kind === 'press').map((row) => row.which);
  const uiPress = ofEvent(obs.events ?? [], 'star', (event) => event.event === 'ui.press').length;
  const band = pane
    .split('\n')
    .filter((line) => /RDCARD|2: (first|second)/u.test(line))
    .map((line) => line.trim());
  const evidence = [
    `presses ${presses.join(', ') || 'none'}, ui.press events ${uiPress}`,
    `band ${clip(band.join(' | '), 200)}`,
  ];
  if (!obs.steps?.cards) {
    return inconclusive([...evidence, 'the band did not show both cards']);
  }
  return presses.length === 1 && presses[0] === 'second'
    ? pass([...evidence, 'the second card took the digit'])
    : fail([...evidence, 'digit 2 did not press the second card alone']);
};

// research/you-should-know.md:61,136: the usage of a $.model.fork, the route You should know uses, counts in /cost.
// The ledger is `$.session.usage().cost`, the total /cost shows; `$.model.complete` is the control.
const verifyCost = (obs) => {
  const record = (obs.bandLog ?? []).find((row) => row.kind === 'fork');
  const total = (obs.screens?.cost ?? '').split('\n').find((line) => /Total cost/u.test(line));
  if (!record) {
    return inconclusive(['/rdprobe fork did not run', `pane ${clip(obs.screens?.fork)}`]);
  }
  const { before, afterFork, afterComplete, fork, complete } = record;
  const expected = haikuUsd(fork?.usage);
  const isNumbers = [before, afterFork, afterComplete].every((value) => typeof value === 'number');
  const evidence = [
    `ledger ${usd(before)} -> ${usd(afterFork)} after the fork -> ${usd(afterComplete)} after the completion`,
    `fork ${fork?.isAnswered ? 'answered' : fork?.reason}: ${clip(fork?.usage, 160)} = ${usd(expected)} ` +
      'at haiku prices',
    `completion delta ${isNumbers ? usd(afterComplete - afterFork) : '?'} ` +
      `for ${usd(haikuUsd(complete?.usage))} of usage`,
    `/cost pane: ${total ? total.trim() : 'no Total cost line'}`,
  ];
  if (!isNumbers) {
    return inconclusive([...evidence, '$.session.usage() gave no cost']);
  }
  if (!expected) {
    return inconclusive([...evidence, 'the fork made no request']);
  }
  return afterFork - before >= expected * 0.5
    ? pass([...evidence, "the fork's usage is in the /cost ledger"])
    : fail([...evidence, "the ledger did not move by the fork's usage"]);
};

// issues/11-ui-prototype.md:37: the ctrl+o transcript view shows the watchdog's $.ui.log row (§13.2).
const verifyCtrlo = (obs) => {
  const pane = obs.screens?.ctrlo ?? '';
  const isOpen = TRANSCRIPT_VIEW.test(pane);
  const tail = pane
    .trim()
    .split('\n')
    .slice(-10)
    .map((line) => line.trim())
    .join(' | ');
  const evidence = [
    `row in the main view ${(obs.screens?.note ?? '').includes(NOTE_MARK)}, ` +
      `in the ctrl+o view ${pane.includes(NOTE_MARK)}`,
    `band in the ctrl+o view ${pane.includes('RDCARD-A')}`,
    `ctrl+o pane ${clip(tail, 240)}`,
  ];
  if (!obs.steps?.noteSent) {
    return inconclusive([...evidence, 'the probe row was not logged']);
  }
  if (!isOpen) {
    return inconclusive([...evidence, 'ctrl+o did not show the transcript view']);
  }
  return pane.includes(NOTE_MARK)
    ? pass([...evidence, 'the ctrl+o view shows the row'])
    : fail([...evidence, 'the ctrl+o view does not show the row']);
};

// research/transcript.md:111, §14.5: /compact fires session.compact and keeps the session id. The probe forces the
// compaction, and the plugin keeps its $.state and store keys by the id across it.
const verifyCompact = (obs) => {
  const events = obs.events ?? [];
  const starts = ofEvent(events, 'session.start');
  const compact = ofEvent(events, 'session.compact')[0];
  const command = ofEvent(events, 'command.run.out', (event) => event.command === 'compact')[0];
  const mark = command?.t ?? compact?.t ?? Infinity;
  const later = mainTurnCompletes(events).find((event) => event.t > mark);
  const ends = ofEvent(events, 'session.end');
  const boundary = (obs.transcript ?? []).filter((row) => row.subtype === 'compact_boundary').length;
  const after = [command?.sessionId, later?.sessionId].filter(Boolean);
  const ids = [...starts.map((event) => event.sessionId), compact?.before, compact?.after, ...after].filter(Boolean);
  const evidence = [
    `session.start ${starts.length}, session.end ${ends.length}, ` +
      `compact boundary rows in ${obs.sessionId}.jsonl ${boundary}`,
    `ids: start ${starts.map((event) => event.sessionId).join(',')} compact ${compact?.before}->${compact?.after} ` +
      `after /compact ${command?.sessionId ?? 'none'} next turn ${later?.sessionId ?? 'none'}`,
    `pane ${clip(obs.screens?.compact?.trim().split('\n').slice(-6).join(' | '), 200)}`,
  ];
  if (!compact && !command) {
    return fail([...evidence, '/compact ran no compaction']);
  }
  if (after.length === 0) {
    return inconclusive([...evidence, 'no session id was read after the compaction']);
  }
  return ids.every((id) => id === ids[0]) && starts.length === 1 && ends.length === 0
    ? pass([...evidence, 'one session id before and after the compaction'])
    : fail([...evidence, 'the session id changed at the compaction']);
};

const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'none');

// §10.6: at session.end of a -p run the plugin writes the dump with $.fs.write; headless-review never runs
// /watchdog dump, so the file there is the session.end one. It holds a record of every review that completed
// before session.end (-p waits for the mod's agents, §10.6). The observer's session.end line, when it is on file,
// dates the write (the dump's `written` has whole seconds).
const verifyDump = (obs) => {
  const sessionId = obs.p?.sessionId;
  const dumps = (obs.dumps ?? []).filter((dump) => dump.sessionId === sessionId);
  if (!sessionId) {
    return fail(['the headless session has no session id']);
  }
  if (dumps.length === 0) {
    return fail([`no dump file for ${sessionId} after the -p run ended`]);
  }
  const { file, text } = dumps.at(-1);
  const written = Date.parse(text.match(/^- written: (\S+)$/mu)?.[1] ?? '');
  const end = ofEvent(obs.events, 'session.end')[0];
  const recorded = new Set(dumpReviews(text).map((review) => review.agentId));
  const reviews = agentTurnCompletes(obs.events).filter((event) => !end || event.t < end.t);
  const missing = [...new Set(reviews.map((event) => event.agentId))].filter((agentId) => !recorded.has(agentId));
  const evidence = [
    `dump ${file} (${dumps.length} for the session)`,
    `written ${isoTime(written)}, observer session.end ${isoTime(end?.t)}`,
    `review records ${recorded.size}; reviews done before session.end ${reviews.length} of ` +
      `${watchdogAgentIds(obs.events).size} spawned`,
  ];
  return expectAll(
    {
      'the dump names the session': text.includes(`- session: ${sessionId}`),
      'it was written at session.end': !end || written >= Math.floor(end.t / 1000) * 1000,
      'it holds a record of each review done before session.end': missing.length === 0,
    },
    missing.length > 0 ? [...evidence, `missing ${missing.join(', ')}`] : evidence
  );
};

export const scenarios = [rdUilog, rdSteer, rdSub, rdTui];

export const checks = [
  {
    id: 'rd-uilog-long',
    title: 'A $.ui.log row over 4096 characters (5000 and 10000) is accepted on 2.1.290',
    source: '§16.5: $.ui.log',
    kind: 'deterministic',
    scenario: 'rd-uilog',
    verify: verifyUilog,
  },
  {
    id: 'rd-note-order',
    title: 'With no thinking block, an appended note lands before the whole text reply',
    source: '§16.5: note wrapper and delivery text',
    kind: 'advisory',
    scenario: 'rd-steer',
    verify: verifyNoteOrder,
  },
  {
    id: 'rd-note-address',
    title: 'With the shipped wrapper, the reply after a note does not address the watchdog',
    source: '§16.5: note wrapper and delivery text',
    kind: 'advisory',
    scenario: 'rd-steer',
    verify: verifyAddress,
  },
  {
    id: 'rd-note-fact',
    title: 'A note with a checkable fact gets checked or used; a note without one may not',
    source: '§16.5: note wrapper and delivery text',
    kind: 'advisory',
    scenario: 'rd-steer',
    verify: verifyFact,
  },
  {
    id: 'rd-cache-append',
    title: 'Cache cost of an append: the request after a mid-reply append still reads the cached prefix',
    source: '§16.5: cache cost of an append',
    kind: 'advisory',
    scenario: 'rd-steer',
    verify: verifyCache,
  },
  {
    id: 'rd-sub-inflight',
    title: 'A late note must land while a tool call is in flight; once the model answers, the run ends',
    source: '§16.5: late subagent notes',
    kind: 'advisory',
    scenario: 'rd-sub',
    verify: verifyInflight,
  },
  {
    id: 'rd-sub-resume',
    title: 'A subagent resumed from its JSONL drops a note appended on a side branch',
    source: '§16.5: late subagent notes',
    kind: 'advisory',
    scenario: 'rd-sub',
    verify: verifyResume,
  },
  {
    id: 'rd-queue-hooks',
    title: "A plugin's hook dispatch for the next turn waits on its earlier held dispatch",
    source: '§16.5: queue order and time',
    kind: 'advisory',
    scenario: 'rd-tui',
    verify: verifyHold,
  },
  {
    id: 'rd-queue-typed',
    title: 'Text typed during the last reply takes the same queue path as a queued prompt',
    source: '§16.5: queue order and time',
    kind: 'advisory',
    scenario: 'rd-tui',
    verify: verifyTyped,
  },
  {
    id: 'rd-hotkey-second',
    title: 'The second band card takes the digit hotkey',
    source: '§16.5: UI',
    kind: 'advisory',
    scenario: 'rd-tui',
    verify: verifyHotkey,
  },
  {
    id: 'rd-cost-fork',
    title: 'The usage of a $.model.fork, the You should know route, counts in /cost',
    source: '§16.5: UI',
    kind: 'advisory',
    scenario: 'rd-tui',
    verify: verifyCost,
  },
  {
    id: 'rd-ctrlo-view',
    title: 'The ctrl+o transcript view shows the watchdog $.ui.log row',
    source: '§16.5: UI (ctrl+o transcript view)',
    kind: 'advisory',
    scenario: 'rd-tui',
    verify: verifyCtrlo,
  },
  {
    id: 'rd-compact-sid',
    title: 'Compaction keeps the same session id',
    source: '§16.5: session changes',
    kind: 'deterministic',
    scenario: 'rd-tui',
    verify: verifyCompact,
  },
  {
    id: 'rd-dump-headless',
    title: 'A -p session writes the dump file with $.fs.write at session.end, with every review record',
    source: '§16.5: headless dump',
    kind: 'deterministic',
    scenario: 'headless-review',
    verify: verifyDump,
  },
];
