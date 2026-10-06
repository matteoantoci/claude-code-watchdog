// Reads what the observer mod (mods/observer) logged in a run: one JSON event for each line, merged over its
// module instances (a reload makes a new instance) and sorted by time.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './env.mjs';
import { readJsonLines } from './run.mjs';

export const readObs = (run) =>
  fs
    .readdirSync(run.logs)
    .filter((name) => name.startsWith('observer-') && name.endsWith('.jsonl'))
    .flatMap((name) => readJsonLines(path.join(run.logs, name)))
    .sort((a, b) => a.t - b.t);

// Polls the observer log until `test(events)` returns a truthy value. Resolves { ok, value, events, ms }.
export const waitObs = async (run, test, { timeoutMs = 120_000, intervalMs = 1000 } = {}) => {
  const begin = Date.now();
  for (;;) {
    const events = readObs(run);
    const value = test(events);
    if (value) {
      return { ok: true, value, events, ms: Date.now() - begin };
    }
    if (Date.now() - begin > timeoutMs) {
      return { ok: false, value, events, ms: Date.now() - begin };
    }
    await sleep(intervalMs);
  }
};

export const ofEvent = (events, ev, test = () => true) => events.filter((event) => event.ev === ev && test(event));

// The review agents: `agent.spawn` results for a `watchdog:<slug>` type.
export const watchdogSpawns = (events) =>
  ofEvent(events, 'agent.spawn.out', (event) => String(event.subagentType).startsWith('watchdog:')).map((event) => ({
    t: event.t,
    type: event.subagentType,
    agentId: event.result?.agentId ?? null,
    model: event.result?.model ?? null,
  }));

export const watchdogAgentIds = (events) =>
  new Set(
    watchdogSpawns(events)
      .map((spawn) => spawn.agentId)
      .filter(Boolean)
  );

export const mainTurnCompletes = (events) => ofEvent(events, 'turn.complete', (event) => !event.agentId);

export const agentTurnCompletes = (events, ids = watchdogAgentIds(events)) =>
  ofEvent(events, 'turn.complete', (event) => ids.has(event.agentId));

// The agent's `note` calls, with the hook result (an admitted note, an ack or a deny).
export const noteCalls = (events) =>
  ofEvent(events, 'tool.call.out', (event) => event.tool === 'mcp__watchdog__note' && event.agentId);

// The rows the plugin appended: a user row whose text holds the `<watchdog-notes>` wrapper (§10.7).
export const noteRows = (events) =>
  ofEvent(events, 'session.append', (event) => !event.agentId && String(event.text).includes('<watchdog-notes'));

// All reviews done: at least `count` watchdog agents completed.
export const reviewsDone =
  (count = 1) =>
  (events) =>
    agentTurnCompletes(events).length >= count;
