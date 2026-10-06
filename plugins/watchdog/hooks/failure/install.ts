import { watchdogOf } from '../agents/ids';
import { currentRoster } from '../agents/roster';
import { parseSubcommand } from '../command/args';
import { COMMAND_LOG_DELAY_MS } from '../constants';
import { changedHealth, rememberErrorText, resetFailures, restoreHealth, stateRows } from './state';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook } from 'claude-code';

// §12.5: one `$.ui.log` row for each change of a problem state; from a `command.run` hook it waits (§13.2).
// §12.3, §14.1: `$.state` keeps the failure state, written when it changed; a refused write loses only what a
// reload would carry over.
const report = async ($: EngineInterface, isCommand = false): Promise<void> => {
  stateRows(currentRoster()).forEach((row) => {
    if (isCommand) {
      $.clock.after(COMMAND_LOG_DELAY_MS, () => {
        $.ui.log(row);
      });
      return;
    }
    $.ui.log(row);
  });
  const health = changedHealth(currentRoster());
  if (health !== undefined) {
    await $.state.set({ plugin: 'watchdog', key: 'health' }, health).catch(() => undefined);
  }
};

// §12.1: the text of a review's error is in its agent's synthetic row; the hook relays the row unchanged.
const onSyntheticRow: Hook<'session.append'> = async (_$, e, next) => {
  if (watchdogOf(e.agentId) !== undefined && e.agentId !== undefined) {
    const text = e.message.content.map((block) =>
      'text' in block && typeof block.text === 'string' ? block.text : ''
    );
    rememberErrorText(e.agentId, text.join('\n'));
  }
  return next(e);
};

// The review area beneath ends reviews and spawns them at boundaries and at person prompts; each row and
// each state write follows.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  const response = yield* next(e);
  if (e.agentId === undefined) {
    await report($);
  }
  return response;
};

const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const result = await next(e);
  await report($);
  return result;
};

const onPrompt: Hook<'prompt.submit'> = async ($, e, next) => {
  const result = await next(e);
  await report($);
  return result;
};

// §5.2: `/watchdog on` beneath sets the states again and tries each watchdog at once, so the failure counts
// of its roster go (§12.3 item 2).
const onCommand: Hook<'command.run'> = async ($, e, next) => {
  const result = await next(e);
  if (parseSubcommand(e.args) === 'on') {
    resetFailures(currentRoster());
    await report($, true);
  }
  return result;
};

// §12.3: at module load, after the on order beneath turned the session on again, the stored failure state
// comes back: the counts, the problems and the halt with its next-try time, so its wait goes on.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  const stored = await $.state.get({ plugin: 'watchdog', key: 'health' }).then(
    (read) => read.value,
    () => undefined
  );
  if (stored !== undefined) {
    restoreHealth(stored, currentRoster());
  }
  await report($);
  return result;
};

// Install before the command and review areas, so that these hooks sit above theirs. The matchers only tell
// these `on()` from the other areas'.
export const installFailure = (
  on: OnEvents<'session.append' | 'turn.step' | 'turn.complete' | 'prompt.submit' | 'command.run' | 'session.start'>
): void => {
  on('session.append', { origin: { kind: 'model', model: '<synthetic>' } }, onSyntheticRow);
  on('turn.step', { model: /^/u }, onStep);
  on('turn.complete', { isAborted: [true, false] }, onComplete);
  on('prompt.submit', { wait: [true, false] }, onPrompt);
  on('command.run', { command: 'watchdog' }, onCommand);
  on('session.start', { isInteractive: [true, false] }, onSessionStart);
};
