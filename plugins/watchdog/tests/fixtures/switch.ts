// Stubs for an L2 test of a session change (spec §14.3): `/clear`, `/resume` and `/branch` fire `session.end` on
// the old session inside the command's `next(e)`, then the process goes on under the new session id. Pass
// `sessionId: () => ids.current` to `stubSession` of ./session, so `$.session.id()` follows the switch.
import { SESSION_ID } from './session';
import type { OnEvents } from '../../hooks/on';
import type { CommandRunInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

export type SwitchStubs = OnEvents<'command.run' | 'session.end'>;

export type Switch = {
  // The session id now.
  current: string;
  // The `session.end` inputs, oldest first.
  readonly ends: { readonly reason: string; readonly sessionId: string }[];
  // The id the next built-in command switches to; undefined for a command that changes nothing (a `/resume`
  // picker closed with no pick).
  to: string | undefined;
  // `/clear`, `/resume <id>` or `/branch` to the session `to`.
  readonly switchTo: (command: string, to: string) => Promise<void>;
};

// A built-in command as the person types it.
export const builtIn = (command: string, args = ''): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
});

// The engine beneath the plugins: a built-in command with a switch pending ends the old session (`/clear` with
// reason `clear`, the others `resume`) and moves to the new id. `$` is the test's engine.
export const stubSwitch = ($: Engine, on: SwitchStubs): Switch => {
  const ids: Switch = {
    current: SESSION_ID,
    ends: [],
    to: undefined,
    switchTo: async (command, to) => {
      ids.to = to;
      await $.command.run(builtIn(command, command === 'resume' ? to : ''));
    },
  };
  on('session.end', (_$, e) => {
    ids.ends.push({ reason: e.reason, sessionId: e.sessionId });
    return { sessionId: e.sessionId };
  });
  on('command.run', async (_$, e) => {
    const { to } = ids;
    if (to !== undefined) {
      ids.to = undefined;
      const sessionId = ids.current;
      await $.session.end({ reason: e.command === 'clear' ? 'clear' : 'resume', sessionId, resume: { id: sessionId } });
      ids.current = to;
    }
    return { text: '' };
  });
  return ids;
};
