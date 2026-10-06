import { describe, expect, test } from 'claude-code/testing';
import { stateIn, stubState } from './fixtures/on-state';
import { SESSION_ID, START, mainRow, stubSession, turnEnd, typed } from './fixtures/session';
import type { StateStubs } from './fixtures/on-state';
import type { SessionStubs } from './fixtures/session';
import type { Engine } from 'claude-code/testing';

type Stubs = SessionStubs & StateStubs;

// §12.2: the reject of the cap for each plugin.
const PLUGIN_CAP = '$.agent.spawn refused: 20 spawns are running at once';

const mainTurn = async ($: Engine, n: number): Promise<void> => {
  await $.session.append(mainRow(`u${n}`, 'user', `Task ${n}.`)).catch(() => undefined);
  await $.turn.complete(turnEnd(`t${n}`));
};

describe('§12.2 a spawn cap', () => {
  test('each capped spawn adds no record to the 100-record log and counts no failure', async ($, on: Stubs) => {
    const seen = stubSession(on, { spawnDeny: PLUGIN_CAP });
    const state = stubState(on);
    await $.session.start(START);
    await $.command.run(typed('on'));
    await mainTurn($, 1);
    await mainTurn($, 2);
    await mainTurn($, 3);

    // Each boundary tried again with the whole backlog.
    expect(seen.spawns.map((spawn) => spawn.prompt.match(/Task \d\./gu))).toEqual([
      ['Task 1.'],
      ['Task 1.', 'Task 2.'],
      ['Task 1.', 'Task 2.', 'Task 3.'],
    ]);
    expect(stateIn(state, SESSION_ID, 'log') ?? []).toEqual([]);
    expect((await $.command.run(typed('status'))).text).toMatch(/\ndefault idle\n/u);
  });
});
