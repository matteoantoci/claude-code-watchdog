// Scenarios that several check groups read. Each one runs the real plugin (plugins/watchdog) with the observer
// beside it, on the fixture project (fixtures/proj), with a haiku watchdog so that a run stays cheap.
import { sleep } from '../lib/env.mjs';
import { collectDumps, readTranscript, subagentTranscripts, takeDump } from '../lib/files.mjs';
import { runHeadless } from '../lib/headless.mjs';
import { agentTurnCompletes, mainTurnCompletes, ofEvent, readObs, waitObs } from '../lib/observe.mjs';
import { createRun } from '../lib/run.mjs';
import { startTui } from '../lib/tui.mjs';

// The probe roster: one haiku watchdog `probe` that always sends one checkable note, so the note paths run.
export const PROBE_INSTRUCTIONS =
  'This session is a live probe of the watchdog plugin. In every review, call `note` exactly once with severity ' +
  '`concern` and a one-line text that starts with WDPROBE and names one fact you checked in a file (for example ' +
  'what `add` in math.js really returns). Then end the review with done.';

export const probeRoster = (extra = {}) => ({
  instructions: PROBE_INSTRUCTIONS,
  watchdogs: [{ name: 'probe', model: 'haiku', effort: 'low' }],
  ...extra,
});

export const REVIEW_PROMPT =
  'Use the Read tool to read math.js, then read a.txt, one tool call at a time. Then tell me in one line what ' +
  'add(2, 3) returns.';

export const RECALL_PROMPT =
  'List each watchdog note that reached you in this conversation, one line each, verbatim, or reply NONE. Do not ' +
  'use tools.';

const until = async (test, timeoutMs) => {
  const begin = Date.now();
  while (!test() && Date.now() - begin < timeoutMs) {
    await sleep(1000);
  }
};

// Headless review: `CLAUDE_WATCHDOG=on claude -p` with stream-json input. Prompt 1 makes two tool rounds; once a
// review ended (or 150 s passed), prompt 2 asks for the notes. stdin closes 20 s after the second main turn.
export const headlessReview = {
  id: 'headless-review',
  title: 'CLAUDE_WATCHDOG=on -p session: two prompts, reviews, dump at session end',
  needs: [],
  run: async (ctx) => {
    const run = createRun(ctx, 'headless-review', { files: { 'WATCHDOG.json': probeRoster() } });
    const p = await runHeadless(run, {
      label: 'p',
      env: { CLAUDE_WATCHDOG: 'on' },
      args: ['--allowedTools', 'Read'],
      input: async (send) => {
        send(REVIEW_PROMPT);
        await until(() => {
          const events = readObs(run);
          return mainTurnCompletes(events).length >= 1 && agentTurnCompletes(events).length >= 1;
        }, 150_000);
        send(RECALL_PROMPT);
        await until(() => mainTurnCompletes(readObs(run)).length >= 2, 120_000);
      },
      closeAfterMs: 20_000,
    });
    await sleep(2000);
    const events = readObs(run);
    return {
      run,
      p,
      events,
      dumps: collectDumps(run, [p.sessionId]),
      transcript: readTranscript(p.sessionId),
      subagents: subagentTranscripts(p.sessionId),
    };
  },
};

// The reply of a `/watchdog` command as the observer saw it (`command.run.out`), after `count` earlier ones.
const commandReply = (run, args, after) =>
  waitObs(
    run,
    (events) =>
      ofEvent(
        events,
        'command.run.out',
        (event) => event.command === 'watchdog' && event.args === args && event.t > after
      )[0],
    { timeoutMs: 30_000 }
  );

// TUI review: `/watchdog on`, a prompt with two tool rounds, the review and its delivery, then `/watchdog status`
// and `/watchdog dump raw`. Screens are kept as text and ANSI. The notes name the planted bug in math.js, so the
// model may try to fix it: mutating tools are denied, else their permission dialog takes the typed commands.
export const tuiReview = {
  id: 'tui-review',
  title: 'TUI session: /watchdog on, a reviewed prompt, /watchdog status, /watchdog dump raw',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'tui-review', { files: { 'WATCHDOG.json': probeRoster() } });
    const tui = await startTui(run, {
      label: 'tui',
      args: ['--allowedTools', 'Read', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
    });
    const screens = {};
    try {
      const t0 = Date.now();
      await tui.type('/watchdog on');
      const on = await commandReply(run, 'on', t0);
      screens.on = tui.capture('on', { ansi: true });
      await tui.type(REVIEW_PROMPT);
      const reviewed = await waitObs(
        run,
        (events) => mainTurnCompletes(events).length >= 1 && agentTurnCompletes(events).length >= 1,
        { timeoutMs: 180_000 }
      );
      screens.reviewed = tui.capture('reviewed', { ansi: true });
      // §10.3: a late note nudges 2 s after the turn ends; give the nudge turn time to run and end.
      await sleep(8000);
      const idle = await tui.waitIdle({ timeoutMs: 120_000 });
      screens.idle = tui.capture('idle', { ansi: true });
      if (!idle.ok) {
        throw new Error(`the main turn did not end in 120 s: ${idle.text.trim().split('\n').slice(-6).join(' | ')}`);
      }
      const t1 = Date.now();
      await tui.type('/watchdog status');
      const status = await commandReply(run, 'status', t1);
      await sleep(1500);
      screens.status = tui.capture('status', { ansi: true });
      const t2 = Date.now();
      await tui.type('/watchdog dump raw');
      const dumpReply = await commandReply(run, 'dump raw', t2);
      await sleep(1500);
      screens.dump = tui.capture('dump', { ansi: true });
      const dumpPath = String(dumpReply.value?.text ?? '').match(/watchdog dump: (\S+\.md)/u)?.[1] ?? null;
      const events = readObs(run);
      return {
        run,
        tui,
        screens,
        events,
        on: on.value ?? null,
        isReviewed: reviewed.ok,
        status: status.value ?? null,
        dump: takeDump(run, dumpPath),
        dumpReply: dumpReply.value ?? null,
      };
    } finally {
      await tui.stop();
    }
  },
};

export const scenarios = [headlessReview, tuiReview];
export const checks = [];
