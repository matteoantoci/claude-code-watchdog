import { describe, expect, test } from 'claude-code/testing';
import { REVIEW_SPAWN, sendNote, stubDelivery } from './fixtures/delivery';
import { stubState } from './fixtures/on-state';
import { NOW, SESSION_ID, START, mainRow, turnEnd, typed } from './fixtures/session';
import { stubSwitch } from './fixtures/switch';
import type { DeliveryStubs } from './fixtures/delivery';
import type { StateStubs } from './fixtures/on-state';
import type { SwitchStubs } from './fixtures/switch';
import type { Engine } from 'claude-code/testing';

type Stubs = DeliveryStubs & StateStubs & SwitchStubs;

const NEW_ID = 'c0ffee00-0000-4000-8000-000000000002';

const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await $.turn.start({ turnId: `t${n}`, text: `Task ${n}.` });
  await $.session.append(mainRow(`u${n}`, 'user', `Task ${n}.`)).catch(() => undefined);
  await $.turn.complete(turnEnd(`t${n}`));
};

const status = async ($: Engine): Promise<string[]> => ((await $.command.run(typed('status'))).text ?? '').split('\n');

// §14.2: the rows of refused writes.
const refusedRows = (logs: readonly string[]): string[] => logs.filter((row) => / not saved: /u.test(row));

describe('§14.2 refused writes', () => {
  test('a refused $.state write shows as last error, and in one row for each session', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current });
    stubState(on, { sessionId: () => ids.current, setDeny: 'state is over 4 MiB' });
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 1);

    expect(await status($)).toContainEqual(
      expect.stringMatching(/^last error: \$\.state \w+ not saved: .*state is over 4 MiB/u)
    );
    expect(refusedRows(seen.logs)).toHaveLength(1);
    expect(refusedRows(seen.logs)[0]).toMatch(/^watchdog: \$\.state \w+ not saved: .*state is over 4 MiB/u);

    await ids.switchTo('clear', NEW_ID);
    await mainTurn($, 2);
    expect(refusedRows(seen.logs)).toHaveLength(2);
  });

  test('a refused $.store write shows as last error, and in one row for each session', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current, storeSetDeny: 'store is over 4 MiB' });
    stubState(on, { sessionId: () => ids.current });
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 1);
    await $.agent.spawn(REVIEW_SPAWN);
    await sendNote($, 'concern', 'parseDate drops the timezone');

    expect(await status($)).toContain(`last error: $.store notes:${SESSION_ID} not saved: store is over 4 MiB`);
    expect(refusedRows(seen.logs)).toEqual([`watchdog: $.store on:${SESSION_ID} not saved: store is over 4 MiB`]);

    await ids.switchTo('branch', NEW_ID);
    expect(refusedRows(seen.logs)).toEqual([
      `watchdog: $.store on:${SESSION_ID} not saved: store is over 4 MiB`,
      `watchdog: $.store notes:${NEW_ID} not saved: store is over 4 MiB`,
    ]);
  });
});

// §14.2: 52 other sessions, `s1` the oldest by `lastUsed`, each with its on flag; `s1` has a note history and
// one of a watched subagent too. The session that runs has an older history than all of them, and a key of
// another shape stays.
const crowdedStore = (): Map<string, unknown> =>
  new Map<string, unknown>([
    [`notes:${SESSION_ID}`, { watchdogs: {}, lastUsed: 0 }],
    ['notes:s1', { watchdogs: {}, lastUsed: 1 }],
    ['notes:s1:asub0001', { watchdogs: {}, lastUsed: 1 }],
    ...Array.from({ length: 52 }, (_, index): [string, unknown] => [
      `on:s${index + 1}`,
      { isOn: false, lastUsed: index + 1 },
    ]),
    ['legacy', { lastUsed: 0 }],
  ]);

describe('§14.2 the $.store prune', () => {
  test('the first write of each session keeps the 50 newest sessions by lastUsed, the writing session too', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    const seen = stubDelivery(on, { sessionId: () => ids.current, store: crowdedStore() });
    stubState(on, { sessionId: () => ids.current });
    await $.session.start(START);
    await $.command.run(typed('on'));

    expect(seen.storeDeletes.toSorted()).toEqual(['notes:s1', 'notes:s1:asub0001', 'on:s1', 'on:s2', 'on:s3']);
    expect(seen.store.has(`notes:${SESSION_ID}`)).toBe(true);
    expect(seen.store.has('on:s4')).toBe(true);
    expect(seen.store.has('legacy')).toBe(true);

    // Once for each session: a later write of the same session prunes nothing, though it reached `$.store`.
    seen.store.set('on:s0', { isOn: false, lastUsed: 0 });
    await seen.clock.advance(1000);
    await $.command.run(typed('off'));
    expect(seen.store.get(`on:${SESSION_ID}`)).toEqual({ isOn: false, lastUsed: NOW + 1000 });
    expect(seen.storeDeletes).toHaveLength(5);

    // The first write of the next session prunes again.
    await ids.switchTo('branch', NEW_ID);
    expect(seen.storeDeletes.slice(5).toSorted()).toEqual(['on:s0', 'on:s4']);
    expect(seen.store.has(`notes:${NEW_ID}`)).toBe(true);
  });

  test('the on flag takes lastUsed from $.clock, and the next session prunes it by that time', async ($, on: Stubs) => {
    const ids = stubSwitch($, on);
    // 50 other sessions, the newest 50 s after the clock now; `s1` the oldest.
    const others = Array.from({ length: 50 }, (_, index): [string, unknown] => [
      `on:s${index + 1}`,
      { isOn: false, lastUsed: NOW + (index + 1) * 1000 },
    ]);
    const seen = stubDelivery(on, { sessionId: () => ids.current, store: new Map(others) });
    stubState(on, { sessionId: () => ids.current });
    await $.session.start(START);
    await seen.clock.advance(1500);
    await $.command.run(typed('on'));
    expect(seen.store.get(`on:${SESSION_ID}`)).toEqual({ isOn: true, source: '/watchdog on', lastUsed: NOW + 1500 });
    expect(seen.storeDeletes).toEqual(['on:s1']);

    // The first write of the next session: the old session (1.5 s) is now older than s2 (2 s).
    await ids.switchTo('branch', NEW_ID);
    expect(seen.storeDeletes.slice(1)).toEqual([`on:${SESSION_ID}`]);
  });
});
