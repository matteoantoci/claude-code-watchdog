import { describe, expect, test } from 'claude-code/testing';
import { stateIn, stubState } from './fixtures/on-state';
import { SESSION_ID, START, stubSession, typed } from './fixtures/session';
import { OPUS_USAGE, TERMINAL, expectTable, mountOutput, runReview, shown, stubRender } from './fixtures/status';
import type { StateStubs } from './fixtures/on-state';
import type { RenderStubs } from './fixtures/status';

type Stubs = RenderStubs & StateStubs;

// The tally of `runReview`: one review with one nit on Opus 5.5, 27.5k tokens, $0.15.
const TALLY = {
  reviews: 1,
  notes: { blocker: 0, concern: 0, nit: 1 },
  tokens: 27_500,
  cost: { usd: 0.15, hasPrice: true, hasUnpriced: false },
  model: 'claude-opus-5-5',
};

const ON = { isOn: true, source: '/watchdog on' };

describe('the cost ledger in $.state (§13.3, §14.6, §15)', () => {
  test('each finished review writes the tally of its watchdog and of the session', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    const state = stubState(on);
    await runReview($, OPUS_USAGE);
    expect(stateIn(state, SESSION_ID, 'ledger')).toEqual({
      watchdogs: { default: TALLY },
      session: TALLY,
      subagents: {},
    });
  });

  test('a reload draws the totals of before it: the ledger comes back at load', async ($, on: Stubs) => {
    stubSession(on);
    stubRender(on);
    const ledger = { watchdogs: { default: TALLY }, session: TALLY, subagents: {} };
    stubState(on, { state: ON, values: new Map([['ledger', ledger]]) });
    await $.session.start(START);
    const reply = await $.command.run(typed('status'));
    await expectTable(await mountOutput($, { args: 'status', text: shown(reply.text) }, TERMINAL));
  });

  test('a subagent type counts its reviews from the ledger, which the 100-record log does not cap', async ($, on: Stubs) => {
    const files = { '/repo/WATCHDOG.json': { text: JSON.stringify({ subagents: { Explore: true } }), mtimeMs: 1 } };
    stubSession(on, { files });
    stubRender(on);
    const ledger = { watchdogs: { default: TALLY }, session: TALLY, subagents: { Explore: 3 } };
    stubState(on, {
      state: ON,
      values: new Map<string, unknown>([
        ['ledger', ledger],
        ['log', []],
      ]),
    });
    await $.session.start(START);
    expect((await $.command.run(typed('status'))).text).toContain('subagents: Explore 3 reviews');
  });
});
