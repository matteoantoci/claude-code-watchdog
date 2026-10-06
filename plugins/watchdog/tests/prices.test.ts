import { describe, expect, test } from 'claude-code/testing';
import { costText, usageCost } from '../hooks/prices';

const usage = (model: string) => ({
  input_tokens: 10_000,
  output_tokens: 2_000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 4_000,
  model,
});

describe('price table (§15)', () => {
  test('a review costs each token class at its price per million tokens of the model that ran', () => {
    // Sonnet 5.5: $2 input, $10 output, $0.20 cache read, $2.50 cache write per million.
    // 0.02 + 0.02 + 0.02 + 0.01 = $0.07.
    expect(usageCost(usage('claude-sonnet-5-5'))?.toFixed(6)).toBe('0.070000');
    // Opus 5.5: $4, $20, $0.20, $5. 0.04 + 0.04 + 0.02 + 0.02 = $0.12.
    expect(usageCost(usage('claude-opus-5-5'))?.toFixed(6)).toBe('0.120000');
    // Haiku 4.5, by its id and by its alias: $1, $5, $0.10, $1.25. 0.01 + 0.01 + 0.01 + 0.005 = $0.035.
    expect(usageCost(usage('claude-haiku-4-5-20251001'))?.toFixed(6)).toBe('0.035000');
    expect(usageCost(usage('claude-haiku-4-5'))?.toFixed(6)).toBe('0.035000');
  });

  test('a model that is not in the table has no price', () => {
    expect(usageCost(usage('claude-opus-4-5'))).toBeNull();
    expect(usageCost(usage('opus'))).toBeNull();
    expect(usageCost(usage('constructor'))).toBeNull();
  });

  test('a cost shows in dollars and cents; an unknown price shows `$?`', () => {
    expect(costText({ usd: 0.1549, hasPrice: true, hasUnpriced: false })).toBe('$0.15');
    expect(costText({ usd: 0, hasPrice: false, hasUnpriced: false })).toBe('$0.00');
    expect(costText({ usd: 0.004, hasPrice: true, hasUnpriced: false })).toBe('<$0.01');
    expect(costText({ usd: 0, hasPrice: false, hasUnpriced: true })).toBe('$?');
    expect(costText({ usd: 1.2, hasPrice: true, hasUnpriced: true })).toBe('$1.20+?');
  });
});
