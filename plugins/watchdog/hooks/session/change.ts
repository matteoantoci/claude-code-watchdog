// §14.3: a session id change (`/clear`, `/resume`, `/branch`). Pure: the session area's hooks read and write.
import { traceNote } from '../log/log';
import { clearHeldNotes, heldNotes } from '../note/notes';
import type { PluginState } from 'claude-code';

type State = PluginState['watchdog'];

// §14.3: `/branch` ends the old session with reason `resume` too; the command that wraps the end tells them apart.
export type ChangeKind = 'clear' | 'resume' | 'branch';

// §14.1, §14.3: the `$.state` values that carry over, as the old session's `$.state` held them at its end. A value
// the old session never wrote stays unwritten, so an off session that never turned on still takes `onByDefault`
// after a reload (§5.1).
export type Carried = {
  readonly on: State['on'] | undefined;
  readonly ids: State['ids'] | undefined;
  readonly health: State['health'] | undefined;
  readonly turns: State['turns'] | undefined;
  readonly reviews: State['reviews'] | undefined;
};

export type SessionChange = { readonly kind: ChangeKind; readonly from: string; readonly carried: Carried };

// The command that runs now, and the change its `session.end` made.
const memory: { command: string | undefined; change: SessionChange | undefined } = {
  command: undefined,
  change: undefined,
};

// §14.3: a `command.run` hook keeps the command before `next(e)`, inside which `session.end` fires.
export const keepCommand = (command: string): void => {
  memory.command = command;
  memory.change = undefined;
};

export const changeKind = (command: string | undefined, reason: 'clear' | 'resume'): ChangeKind => {
  if (reason === 'clear') {
    return 'clear';
  }
  return command === 'branch' ? 'branch' : 'resume';
};

// §14.3: the `session.end` hook keeps the old session's id and values.
export const endSession = (from: string, reason: 'clear' | 'resume', carried: Carried): void => {
  memory.change = { kind: changeKind(memory.command, reason), from, carried };
};

// The change the command's `session.end` made, once; undefined when it made none (a `/resume` picker closed
// with no pick).
export const takeChange = (): SessionChange | undefined => {
  const { change } = memory;
  memory.command = undefined;
  memory.change = undefined;
  return change;
};

// §14.3, §14.4: the notes that wait go (the cards, the nudge, the undelivered notes of a review that runs); the
// review log marks each `discarded`.
export const discardNotes = (): void => {
  heldNotes().forEach((note) => {
    traceNote({ ...note, delivery: 'discarded' });
  });
  clearHeldNotes();
};
