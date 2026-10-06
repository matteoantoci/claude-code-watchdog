import { describe, expect, mock, test } from 'claude-code/testing';
import {
  PERSON_PROMPT,
  REVIEW_SPAWN,
  TASK_NOTIFICATION,
  nudgeTurnText,
  sendNote,
  startReview,
  stubDelivery,
  wrapped,
} from './fixtures/delivery';
import { stateIn, stubState } from './fixtures/on-state';
import {
  NOW,
  REVIEW_AGENT,
  SESSION_ID,
  START,
  USAGE,
  mainRow,
  stubAfterAtOnce,
  stubSession,
  turnEnd,
  typed,
} from './fixtures/session';
import type { OnEvents } from '../hooks/on';
import type { DeliveryEvents, DeliverySeen, DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { SessionEvents } from './fixtures/session';
import type { Engine } from 'claude-code/testing';

const CONCERN = 'parseDate drops the timezone';
const BLOCKER = 'The migration deletes the users table';

const personTurn = async ($: Engine, turnId: string): Promise<void> => {
  await $.prompt.submit(PERSON_PROMPT);
  await $.turn.start({ text: PERSON_PROMPT.text, turnId });
};

// The review agent's own turn.complete: the late notes it sent while the session was idle start the wait.
const reviewEnd = async ($: Engine): Promise<void> => {
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
};

// The mod's nudges: the prompts it submitted, as the engine got them.
const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

// What the model reads with the newest person prompt (the mod's nudge may carry no origin in the kit).
const asideOf = (seen: DeliverySeen): readonly string[] | undefined =>
  seen.prompts.findLast((prompt) => prompt.text === PERSON_PROMPT.text)?.context;

// The engine starts and ends the turn of the newest nudge.
const nudgeTurn = async ($: Engine, seen: DeliverySeen, turnId: string): Promise<void> => {
  await $.turn.start({ text: nudgeTurnText(nudges(seen).at(-1) ?? ''), turnId });
  await $.turn.complete(turnEnd(turnId));
};

// A late blocker of the idle session, and the end of the review that sent it.
const lateBlocker = async ($: Engine, text: string): Promise<void> => {
  await sendNote($, 'blocker', text);
  await reviewEnd($);
};

describe('late note and nudge', () => {
  test('a late concern starts one nudge from the 2 s wait after the review ends', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (nudged)`);

    await reviewEnd($);
    await seen.clock.advance(1999);
    expect(nudges(seen)).toEqual([]);
    await seen.clock.advance(1);
    expect(nudges(seen)).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });

  test('a steer with no tool result before the turn ended and the late notes of the 2 s wait share one nudge', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await sendNote($, 'concern', CONCERN);
    expect(seen.logs.at(-1)).toBe(`[concern] default: ${CONCERN} (steered)`);

    await $.turn.complete(turnEnd('t1'));
    await seen.clock.advance(1000);
    await sendNote($, 'blocker', BLOCKER);
    await seen.clock.advance(1000);
    expect(nudges(seen)).toEqual([
      wrapped(`<note severity="concern">${CONCERN}</note>`, `<note severity="blocker">${BLOCKER}</note>`),
    ]);
  });

  test('a turn that starts in the wait takes the late note as a steer; at its end the note is late again', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    await sendNote($, 'concern', CONCERN);
    await reviewEnd($);
    await seen.clock.advance(1000);

    await $.prompt.submit(TASK_NOTIFICATION);
    await $.turn.start({ text: TASK_NOTIFICATION.text, turnId: 't2' });
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([]);

    await $.turn.complete(turnEnd('t2'));
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([wrapped(`<note severity="concern" turns_ago="1">${CONCERN}</note>`)]);
  });

  test('after Esc no nudge goes out; the late notes go as an aside on the next person prompt', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await sendNote($, 'concern', CONCERN);
    await $.turn.complete({ ...turnEnd('t1'), reason: 'aborted', isAborted: true });
    await lateBlocker($, BLOCKER);
    expect(seen.logs.at(-1)).toBe(`[blocker] default: ${BLOCKER} (held)`);
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([]);

    await $.prompt.submit(PERSON_PROMPT);
    expect(seen.prompts.at(-1)?.context).toEqual([
      wrapped(`<note severity="concern">${CONCERN}</note>`, `<note severity="blocker">${BLOCKER}</note>`),
    ]);
  });

  test('one nudge for each person prompt: the nudge turn and a task notification turn earn none', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    await lateBlocker($, 'Blocker one.');
    await seen.clock.advance(2000);
    expect(nudges(seen).length).toBe(1);

    await nudgeTurn($, seen, 'n1');
    await lateBlocker($, 'Blocker two.');
    await $.prompt.submit(TASK_NOTIFICATION);
    await $.turn.start({ text: TASK_NOTIFICATION.text, turnId: 't2' });
    await $.turn.complete(turnEnd('t2'));
    await lateBlocker($, 'Blocker three.');
    expect(seen.logs.slice(-2)).toEqual([
      '[blocker] default: Blocker two. (held)',
      '[blocker] default: Blocker three. (held)',
    ]);
    await seen.clock.advance(2000);
    expect(nudges(seen).length).toBe(1);

    await personTurn($, 't3');
    expect(asideOf(seen)).toEqual([
      wrapped(
        '<note severity="blocker" turns_ago="1">Blocker two.</note>',
        '<note severity="blocker">Blocker three.</note>'
      ),
    ]);
    await $.turn.complete(turnEnd('t3'));
    await lateBlocker($, 'Blocker four.');
    await seen.clock.advance(2000);
    expect(nudges(seen).length).toBe(2);
  });

  test('a task notification turn keeps the budget: its late note gets the nudge', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await $.prompt.submit(TASK_NOTIFICATION);
    await $.turn.start({ text: TASK_NOTIFICATION.text, turnId: 't1' });
    await $.turn.complete(turnEnd('t1'));
    await sendNote($, 'concern', CONCERN);
    await reviewEnd($);
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([wrapped(`<note severity="concern">${CONCERN}</note>`)]);
  });

  test(
    'immuneTurns 1: a late concern in the cooldown goes as an aside, a blocker is exempt',
    { options: { immuneTurns: 1 } },
    async ($, on: DeliveryStubs) => {
      const seen = stubDelivery(on);
      await startReview($);
      await personTurn($, 't1');
      await $.turn.complete(turnEnd('t1'));
      await sendNote($, 'concern', 'Concern one.');
      await reviewEnd($);
      await seen.clock.advance(2000);
      await nudgeTurn($, seen, 'n1');

      // Turn 3 is 1 turn after the nudge turn: in the cooldown.
      await personTurn($, 't3');
      await $.turn.complete(turnEnd('t3'));
      await sendNote($, 'concern', 'Concern two.');
      await lateBlocker($, BLOCKER);
      await seen.clock.advance(2000);
      expect(nudges(seen).at(-1)).toBe(wrapped(`<note severity="blocker">${BLOCKER}</note>`));
      await nudgeTurn($, seen, 'n2');

      await personTurn($, 't5');
      expect(asideOf(seen)).toEqual([wrapped('<note severity="concern" turns_ago="1">Concern two.</note>')]);
      await $.turn.complete(turnEnd('t5'));
      // Turn 6 is 2 turns after the nudge turn n2: out of the cooldown.
      await personTurn($, 't6');
      await $.turn.complete(turnEnd('t6'));
      await sendNote($, 'concern', 'Concern three.');
      await reviewEnd($);
      await seen.clock.advance(2000);
      expect(nudges(seen).length).toBe(3);
    }
  );

  test(
    'the status first line shows the nudge budget and the cooldown; a bad immuneTurns gives a warning',
    { options: { immuneTurns: 7 } },
    async ($, on: DeliveryStubs) => {
      const seen = stubDelivery(on);
      await startReview($);
      const before = (await $.command.run(typed('status'))).text ?? '';
      expect(before.split('\n')[0]).toBe('watchdog on · nudge 0/1 · cooldown 0');
      expect(before).toContain('warning: immuneTurns 7 is not a whole number from 0 to 5; the cooldown is 3 turns');

      await personTurn($, 't1');
      await $.turn.complete(turnEnd('t1'));
      await lateBlocker($, BLOCKER);
      await seen.clock.advance(2000);
      await nudgeTurn($, seen, 'n1');
      const after = (await $.command.run(typed('status'))).text ?? '';
      expect(after.split('\n')[0]).toBe('watchdog on · nudge 1/1 · cooldown 3');
    }
  );

  test('a nudge that waits in $.state is set again at load', async ($, on: OnEvents<DeliveryEvents | 'state.get'>) => {
    const waiting = {
      nudges: 0,
      nudgeTurn: null,
      dueAt: NOW + 500,
      notes: [{ watchdog: 'default', agentId: REVIEW_AGENT, severity: 'concern', text: CONCERN, turn: 3 }],
    };
    const seen = stubDelivery(on);
    on('state.get', (_$, e, next) => {
      if (e.key === 'nudge') {
        return { value: { value: waiting, version: 2 } };
      }
      return e.key === 'turns' ? { value: { value: 4, version: 4 } } : next(e);
    });
    await $.session.start(START);
    await seen.clock.advance(499);
    expect(nudges(seen)).toEqual([]);
    await seen.clock.advance(1);
    expect(nudges(seen)).toEqual([wrapped(`<note severity="concern" turns_ago="1">${CONCERN}</note>`)]);
  });
});

describe('§5.2 `/watchdog off` and a nudge that waits', () => {
  test('the off clears the nudge in $.state too, so a reload inside the 2 s wait sends nothing', async ($, on: DeliveryStubs &
    StateStubs) => {
    const seen = stubDelivery(on);
    const state = stubState(on);
    await startReview($);
    await lateBlocker($, BLOCKER);
    expect(stateIn(state, SESSION_ID, 'nudge')).toMatchObject({ dueAt: NOW + 2000 });

    await $.command.run(typed('off'));
    expect(stateIn(state, SESSION_ID, 'nudge')).toMatchObject({ dueAt: null, notes: [] });
    await seen.clock.advance(2000);
    expect(nudges(seen)).toEqual([]);
  });
});

describe('the nudge budget after a refused nudge (§10.3, §10.4)', () => {
  type RefusedStubs = OnEvents<SessionEvents | 'clock.after' | 'state.get' | 'state.set'>;

  test('a nudge whose submit rejects gives the budget back and leaves no wait in $.state', async ($, on: RefusedStubs) => {
    // The 2 s wait runs at once, and no hook answers `prompt.submit` beneath the mod, so the nudge rejects.
    const seen = stubSession(on);
    stubAfterAtOnce(on);
    const state = stubState(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await $.session.append(mainRow('u1', 'user', 'Fix the parser.')).catch(() => undefined);
    await $.turn.complete(turnEnd('t1'));
    await $.agent.spawn(REVIEW_SPAWN);
    await lateBlocker($, BLOCKER);

    expect(seen.logs.at(-1)).toBe(`[blocker] default: ${BLOCKER} (nudged)`);
    expect((await $.command.run(typed('status'))).text?.split('\n')[0]).toBe('watchdog on · nudge 0/1 · cooldown 0');
    expect(stateIn(state, SESSION_ID, 'nudge')).toMatchObject({ nudges: 0, dueAt: null, notes: [] });
  });

  test('a person prompt during a refused nudge leaves the new budget at 0, so the next prompt gets 1 nudge', async ($, on: DeliveryStubs) => {
    const clock = mock.clock(on, { now: NOW });
    stubSession(on, { isClockMocked: true });
    const submitted: string[] = [];
    // The person sends a prompt while the nudge submit waits; then the engine drops the nudge.
    on('prompt.submit', async (_$, e) => {
      submitted.push(e.text);
      if (!e.text.startsWith('<watchdog-notes>')) {
        return { text: e.text };
      }
      await $.prompt.submit(PERSON_PROMPT);
      return { drop: 'the session is busy' };
    });
    on('turn.start', (_$, e) => ({ turnId: e.turnId }));
    await startReview($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    await lateBlocker($, BLOCKER);
    await clock.advance(2000);

    expect(submitted.filter((text) => text.startsWith('<watchdog-notes>'))).toHaveLength(1);
    expect((await $.command.run(typed('status'))).text?.split('\n')[0]).toBe('watchdog on · nudge 0/1 · cooldown 0');
  });
});
