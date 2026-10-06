import { ownContext } from '../agents/ids';
import { currentRosterConfig, watchdogBySlug } from '../agents/roster';
import { isOwnLoop, isOwnRow } from '../agents/self-review';
import { addStatusLines } from '../command/status';
import { currentRouting, routeNote } from '../delivery/nudge';
import { currentTurn } from '../delivery/turns';
import { wrapNotes, wrappedNote } from '../delivery/wrapper';
import { currentFeed } from '../feed/feed';
import { currentMode } from '../lifecycle/mode';
import { dropHeldNote } from '../note/drop';
import { normalizeNote } from '../note/guard';
import {
  EMPTY_HISTORY,
  isRepeat,
  liveHistory,
  notesKey,
  readHistory,
  recordGuardKey,
  setLiveHistory,
} from '../note/history';
import {
  addDeliveryRoute,
  addNoteBinding,
  heldNotes,
  holdNote,
  logRow,
  replaceHeldNote,
  takeBoundNotes,
} from '../note/notes';
import { currentLedger } from '../status/ledger';
import {
  endSubagent,
  isSubagentRunning,
  isSubagentSteer,
  optInSlugs,
  recordSubagentRow,
  subagentRoute,
  subagentStatusLines,
  takeDirtySubagents,
  watchSubagent,
} from './watch';
import type { HeldNote } from '../note/notes';
import type { OnEvents } from '../on';
import type { EngineInterface, MatchedHook } from 'claude-code';

// The shipped `prompts/boundary-guidance.md` (§10.7), read once.
const memory: { guidance: string | undefined } = { guidance: undefined };

// §11.1: the agent types that an `agent.offer` gave since this load.
const offered = new Set<string>();

// §14.1: `$.state` family `subagents` keeps each watched subagent by its `agentId`. The live copy is module
// memory, so a refused write loses only what a reload would carry over.
const saveSubagents = async ($: EngineInterface): Promise<void> => {
  await Promise.all(
    takeDirtySubagents().map(async ({ agentId, ...watch }) =>
      $.state.set({ plugin: 'watchdog', key: 'subagents', id: agentId }, watch).catch(() => undefined)
    )
  );
};

// §11.1: a subagent counts only when the mod learns its `agentId` from the `next(e)` result of an `agent.spawn`
// whose type the roster opts in. Its watchdogs are the ones that review now (those with a feed cursor).
const onSpawn: MatchedHook<'agent.spawn', { fork: false }> = async ($, e, next) => {
  const result = await next(e);
  const isInWatchdog = isOwnLoop(e.parentAgentId, ownContext());
  const watchdogs =
    currentMode() === 'on' && result.agentId !== undefined
      ? optInSlugs(currentRosterConfig().subagents, Object.keys(currentFeed().cursors), { ...e, isInWatchdog })
      : [];
  if (result.agentId !== undefined && watchdogs.length > 0) {
    watchSubagent({ agentId: result.agentId, type: e.subagentType, task: e.prompt, watchdogs });
    await saveSubagents($);
  }
  return result;
};

// §11.2, §7.3: each row of a watched subagent enters its feed, except the watchdog's own rows (the steer that
// the subagent read as `context` too). The row is kept before `next(e)`, which the hook relays.
const onRow: MatchedHook<'session.append', { agentId: RegExp }> = async ($, e, next) => {
  const isRecorded = currentMode() === 'on' && !isOwnRow(e, ownContext()) && recordSubagentRow(e);
  const result = await next(e);
  if (isRecorded) {
    await saveSubagents($);
  }
  return result;
};

// §11.3, §10.7: the notes of a steer into a subagent in one wrapper, with no subagent label: the subagent reads
// them as notes on its own work.
const steerText = async ($: EngineInterface, notes: readonly HeldNote[]): Promise<string> => {
  memory.guidance ??= await $.fs.read(`${$.plugin.root}/prompts/boundary-guidance.md`);
  return wrapNotes(
    memory.guidance,
    notes.map((note) =>
      wrappedNote({ ...note, subagent: undefined }, watchdogBySlug(note.watchdog)?.name ?? note.watchdog, currentTurn())
    )
  );
};

// §11.3: while a watched subagent runs, the notes on it go inside its next tool result, as `context` returned
// after `next(e)`. A deny carries no `context`, and a steer that cannot be written waits for the next call.
const onCall: MatchedHook<'tool.call', { agentId: RegExp; tool: RegExp }> = async ($, e, next) => {
  const result = await next(e);
  const notes = result.deny === undefined && e.agentId !== undefined ? takeBoundNotes(e.agentId) : [];
  const text = notes.length === 0 ? undefined : await steerText($, notes).catch(() => undefined);
  if (result.deny !== undefined || text === undefined) {
    notes.forEach(holdNote);
    return result;
  }
  return { ...result, context: [...(result.context ?? []), text] };
};

// §9.6: the live copy of the primary agent's `notes:<sessionId>`, loaded at the first hook that needs it.
const loadPrimaryHistory = async ($: EngineInterface): Promise<string> => {
  const sessionId = await $.session.id();
  const stored = liveHistory(sessionId) === undefined ? await $.store.get(notesKey(sessionId)) : undefined;
  if (liveHistory(sessionId) === undefined) {
    setLiveHistory(sessionId, readHistory(stored));
  }
  return sessionId;
};

// §9.6, §14.2: the live copy written back with `lastUsed`; the store area shows a refused write.
const savePrimaryHistory = async ($: EngineInterface, sessionId: string): Promise<void> => {
  const history = { ...(liveHistory(sessionId) ?? EMPTY_HISTORY), lastUsed: await $.clock.now() };
  setLiveHistory(sessionId, history);
  await $.store.set(notesKey(sessionId), history).catch(() => undefined);
};

// §11.4: one late note on a subagent, checked against the primary agent's key set. A repeat leaves the held list
// and the band (the drop path of a displaced note, §9.4) and gives its row; any other note records its key there
// and takes the primary agent's route (§10).
const settleLate = (sessionId: string, note: HeldNote): string[] => {
  const history = liveHistory(sessionId) ?? EMPTY_HISTORY;
  const entry = { key: normalizeNote(note.text), severity: note.severity };
  if (isRepeat(history, note.watchdog, entry)) {
    dropHeldNote(note);
    const name = watchdogBySlug(note.watchdog)?.name ?? note.watchdog;
    return [logRow({ ...note, delivery: 'dropped:duplicate' }, name)];
  }
  setLiveHistory(sessionId, recordGuardKey(history, note.watchdog, entry));
  replaceHeldNote(note, { ...note, delivery: routeNote(note.severity, currentRouting()) });
  return [];
};

// §11.3: the subagent's `turn.complete` ends its loop. Each note that it did not get as a steer is a late note
// for the primary agent now, before the hooks beneath arm the nudge (§10.3).
const sendLateNotes = async ($: EngineInterface, agentId: string): Promise<void> => {
  endSubagent(agentId);
  const late = heldNotes().filter((note) => note.subagent?.agentId === agentId && note.delivery === 'steered');
  if (late.length === 0) {
    return;
  }
  const sessionId = await loadPrimaryHistory($);
  late.flatMap((note) => settleLate(sessionId, note)).forEach((row) => $.ui.log(row));
  await savePrimaryHistory($, sessionId);
};

const onLoopEnd: MatchedHook<'turn.complete', { agentId: RegExp }> = async ($, e, next) => {
  if (e.agentId !== undefined && isSubagentRunning(e.agentId)) {
    await sendLateNotes($, e.agentId);
  }
  const result = await next(e);
  await saveSubagents($);
  return result;
};

// §11: a watched subagent's feed, its steers and its late notes. The route claims a note on a subagent that runs
// before the primary agent's routes do (install this area before the delivery area). The offers give the types
// that exist, for the status warning on a `subagents` key that names none (§11.1).
export const installSubagents = (
  on: OnEvents<'agent.offer' | 'agent.spawn' | 'session.append' | 'tool.call' | 'turn.complete'>
): void => {
  on('agent.offer', { agent: /^(?!watchdog:)/u }, (_$, e, next) => {
    offered.add(e.agent);
    return next(e);
  });
  on('agent.spawn', { fork: false }, onSpawn);
  on('session.append', { agentId: /^/u }, onRow);
  on('tool.call', { agentId: /^/u, tool: /^/u }, onCall);
  on('turn.complete', { agentId: /^/u }, onLoopEnd);
  addDeliveryRoute(subagentRoute);
  addNoteBinding(isSubagentSteer);
  // §11.4, §13.3: the subagent lines and warnings.
  addStatusLines(() =>
    currentMode() === 'on'
      ? subagentStatusLines(Object.keys(currentRosterConfig().subagents), offered, currentLedger().subagents)
      : []
  );
};
