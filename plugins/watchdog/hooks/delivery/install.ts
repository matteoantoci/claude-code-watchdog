import { ownContext } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { isOwnToolCall } from '../agents/self-review';
import { errorText } from '../errors';
import { addLogRecord, currentLog, errorRecord } from '../log/log';
import { addDeliveryRoute, holdNote, takeNotes } from '../note/notes';
import { countTurn, currentTurn } from './turns';
import { wrapNotes, wrappedNote } from './wrapper';
import type { HeldNote, Note } from '../note/notes';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, MatchedHook } from 'claude-code';

type SteerHook = MatchedHook<'tool.call', { tool: RegExp }>;

// The shipped `prompts/boundary-guidance.md` (§10.7), read once.
const memory: { guidance: string | undefined } = { guidance: undefined };

const guidance = async ($: EngineInterface): Promise<string> => {
  memory.guidance ??= await $.fs.read(`${$.plugin.root}/prompts/boundary-guidance.md`);
  return memory.guidance;
};

// §10.7: the main-loop counter adds 1 at each `turn.start`; `$.state` key `turns` keeps a copy (§14.1).
const onTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  const turn = countTurn();
  await $.state.set({ plugin: 'watchdog', key: 'turns' }, turn).catch(() => undefined);
  return next(e);
};

// §10.1: one user row with the wrapped notes. Returns the reason of a reject or a deny, or undefined.
const appendNotes = async ($: EngineInterface, notes: readonly HeldNote[]): Promise<string | undefined> => {
  try {
    const turn = currentTurn();
    const text = wrapNotes(
      await guidance($),
      notes.map((note) => wrappedNote(note, watchdogBySlug(note.watchdog)?.name ?? note.watchdog, turn))
    );
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } });
    return 'deny' in appended ? appended.deny : undefined;
  } catch (error) {
    return errorText(error);
  }
};

// §10.1: a failed append keeps the notes undelivered for the late-note route (§10.3) and writes one
// review-log error.
const keepUndelivered = async ($: EngineInterface, notes: readonly HeldNote[], problem: string): Promise<void> => {
  for (const note of notes) {
    holdNote({ ...note, delivery: 'held' });
  }
  const names = notes.map((note) => watchdogBySlug(note.watchdog)?.name ?? note.watchdog);
  const watchdog = [...new Set(names)].join(', ');
  addLogRecord(errorRecord({ watchdog, time: await $.clock.now(), error: `steer append failed: ${problem}` }));
  await $.state.set({ plugin: 'watchdog', key: 'log' }, currentLog()).catch(() => undefined);
};

const steer = async ($: EngineInterface): Promise<void> => {
  const notes = takeNotes('steered');
  if (notes.length === 0) {
    return;
  }
  const problem = await appendNotes($, notes);
  if (problem !== undefined) {
    await keepUndelivered($, notes, problem);
  }
};

// §10.1: the ready steers go after the next main-loop tool result, once `next(e)` resolved. The mod's own
// synthetic calls (§7.3) and every subagent call steer nothing.
const onToolCall: SteerHook = async ($, e, next) => {
  const result = await next(e);
  if (e.agentId === undefined && !isOwnToolCall(e, ownContext(), next.origin.plugin)) {
    await steer($);
  }
  return result;
};

// §10.1: a `concern` or a `blocker` waits for the next main-loop tool result.
const steerRoute = (note: Note): 'steered' | undefined =>
  note.severity === 'concern' || note.severity === 'blocker' ? 'steered' : undefined;

export const installDelivery = (on: OnEvents<'turn.start' | 'tool.call'>): void => {
  on('turn.start', onTurnStart);
  on('tool.call', { tool: /^/u }, onToolCall);
  addDeliveryRoute(steerRoute);
};
