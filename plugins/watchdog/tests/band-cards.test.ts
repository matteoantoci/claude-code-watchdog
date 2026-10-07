import { describe, expect, test } from 'claude-code/testing';
import {
  EMPTY_BAND,
  addCard,
  bandState,
  cardKey,
  changeCard,
  clearCards,
  removeCard,
  restoreBand,
  toggleCard,
} from '../hooks/band/cards';
import type { HeldNote } from '../hooks/note/notes';

const EXPLORE = { agentId: 'asub0001', type: 'Explore' };

const held = (subagent?: typeof EXPLORE): HeldNote => ({
  watchdog: 'default',
  agentId: 'afake0001',
  severity: 'concern',
  text: 'The regex accepts expired tokens.',
  batchEdits: null,
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
    expect(bandState(3)).toMatchObject({ turn: 3, seq: 2 });
  });

  test('a band of an earlier version comes back without its session totals', () => {
    restoreBand(EMPTY_BAND);
    addCard(held());
    const { cards } = bandState(2);
    const earlier = { cards, totals: { blocker: 0, concern: 9, nit: 0 }, turn: 2, seq: 1, expanded: null };
    restoreBand(earlier);
    expect(bandState(2)).toEqual({ cards, turn: 2, seq: 1, expanded: null });
  });
});

describe('expanded card (§13.1)', () => {
  const other: HeldNote = { ...held(), text: 'The cache key drops the locale.' };

  // A band of two cards, from module memory; their keys in the order they came.
  const twoCards = (): readonly string[] => {
    restoreBand(EMPTY_BAND);
    addCard(held());
    addCard(other);
    return bandState(1).cards.map((card) => card.key);
  };

  test('a press expands a card and collapses the one expanded before; a press on it again collapses it', () => {
    const [first = '', second = ''] = twoCards();
    toggleCard(first);
    expect(bandState(1).expanded).toBe(first);
    toggleCard(second);
    expect(bandState(1).expanded).toBe(second);
    toggleCard(second);
    expect(bandState(1).expanded).toBeNull();
  });

  test('the expanded card collapses as it leaves, and when the cards clear; a press on a gone card changes nothing', () => {
    const [first = '', second = ''] = twoCards();
    toggleCard(first);
    removeCard(cardKey(held()));
    expect(bandState(1)).toMatchObject({ cards: [{ key: second }], expanded: null });
    toggleCard(second);
    removeCard(cardKey(held()));
    expect(bandState(1).expanded).toBe(second);
    toggleCard(first);
    expect(bandState(1).expanded).toBe(second);
    clearCards();
    expect(bandState(1)).toMatchObject({ cards: [], expanded: null });
  });
});
