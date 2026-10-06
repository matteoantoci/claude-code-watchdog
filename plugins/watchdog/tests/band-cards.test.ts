import { describe, expect, test } from 'claude-code/testing';
import { EMPTY_BAND, addCard, bandState, changeCard, restoreBand } from '../hooks/band/cards';
import type { HeldNote } from '../hooks/note/notes';

const EXPLORE = { agentId: 'asub0001', type: 'Explore' };

const held = (subagent?: typeof EXPLORE): HeldNote => ({
  watchdog: 'default',
  agentId: 'afake0001',
  severity: 'concern',
  text: 'The regex accepts expired tokens.',
  turn: 1,
  delivery: 'steered',
  ...(subagent === undefined ? {} : { subagent }),
});

describe('band cards (§13.1, §11.3)', () => {
  test('a note on a subagent shows its type; the same text on the primary agent is another card', () => {
    restoreBand(EMPTY_BAND);
    addCard(held(EXPLORE));
    addCard(held());
    changeCard(held(EXPLORE), { ...held(EXPLORE), delivery: 'nudged' });
    expect(bandState(3).cards.map(({ subagent, delivery }) => ({ subagent, delivery }))).toEqual([
      { subagent: 'Explore', delivery: 'nudged' },
      { subagent: undefined, delivery: 'steered' },
    ]);
    expect(bandState(3)).toMatchObject({ totals: { blocker: 0, concern: 2, nit: 0 }, turn: 3, seq: 2 });
  });
});
