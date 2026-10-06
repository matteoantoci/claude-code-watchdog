import { watchdogOf } from '../agents/ids';
import { watchdogBySlug } from '../agents/roster';
import { errorText } from '../errors';
import { traceNote } from '../log/log';
import { deliveryFor, guardNote, holdNote, logRow } from './notes';
import { parseNote } from './tool';
import type { OnEvents } from '../on';
import type { EngineInterface, MatchedHook, ToolCallResult } from 'claude-code';

type NoteHook = MatchedHook<'tool.call', { tool: 'mcp__watchdog__note' }>;
type NoteCall = Parameters<NoteHook>[1];

// §8.3: the deny for the main loop and for an unknown agent; §9.5: the ack of an admitted note.
const NOT_A_WATCHDOG = 'Only watchdog agents can call this tool.';
const ADMITTED = 'Queued. Do not re-raise.';
const BAD_ARGUMENTS = 'A note needs `note` text and a `severity` of nit, concern or blocker.';

// §8.3, §9, §13.2: a note of a known watchdog passes the guards, takes its delivery state from the first
// route that claims it, waits for that delivery and writes one log row.
const admitNote = ($: EngineInterface, e: NoteCall): ToolCallResult => {
  const watchdog = watchdogOf(e.agentId);
  if (watchdog === undefined || e.agentId === undefined) {
    return { deny: NOT_A_WATCHDOG };
  }
  const input = parseNote(e);
  if (input === undefined) {
    return { deny: BAD_ARGUMENTS };
  }
  const note = { watchdog, agentId: e.agentId, ...input };
  const dropped = guardNote(note);
  if (dropped !== undefined) {
    return { result: dropped };
  }
  const held = { ...note, delivery: deliveryFor(note) };
  holdNote(held);
  traceNote(held);
  $.ui.log(logRow(held, watchdogBySlug(watchdog)?.name ?? watchdog));
  return { result: ADMITTED };
};

// §8.3: the hook answers without `next(e)`, so no permission check runs; it catches every error, because
// a throw opens a permission dialog in front of the person.
const onNote: NoteHook = ($, e) => {
  try {
    return admitNote($, e);
  } catch (error) {
    return { deny: `The note was not recorded: ${errorText(error)}` };
  }
};

// §8.3: the `.catch` form of 2.1.290; it denies only a call from a watchdog agent or a fork. The tool
// name is a literal so that `claude plugin validate` lists the matcher.
export const installNote = (on: OnEvents<'tool.call'>): void => {
  on('tool.call', { tool: 'mcp__watchdog__note' }, onNote).catch((_$, e, next) =>
    next.called || next.origin.plugin !== 'watchdog' || e.agentId === undefined
      ? next(e)
      : { deny: 'The note was not recorded.' }
  );
};
