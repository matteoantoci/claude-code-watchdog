import { USD_CENT, USD_DIGITS } from './constants';
import type { TurnUsage } from 'claude-code';

// §15, build-session choice "Price table": USD for each million tokens of each token class, keyed on
// `TurnUsage.model` (the id the API reports). The cache write is the 5-minute write.
// Prices of 2026-10-06, from https://platform.claude.com/docs/en/about-claude/pricing.
type Price = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

const HAIKU_4_5: Price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-haiku-4-5': HAIKU_4_5,
};

const TOKENS_PER_PRICE = 1_000_000;

// §15: the USD of one review's usage; null for a model that is not in the table.
export const usageCost = (usage: TurnUsage): number | null => {
  const price = Object.hasOwn(PRICES, usage.model) ? PRICES[usage.model] : undefined;
  if (price === undefined) {
    return null;
  }
  const micro =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.cacheWrite;
  return micro / TOKENS_PER_PRICE;
};

// A sum of review costs: the USD of the priced reviews, and whether any review had a price or ran a model that
// is not in the table.
export type Cost = { readonly usd: number; readonly hasPrice: boolean; readonly hasUnpriced: boolean };

export const NO_COST: Cost = { usd: 0, hasPrice: false, hasUnpriced: false };

const usdText = (usd: number): string => (usd > 0 && usd < USD_CENT ? '<$0.01' : `$${usd.toFixed(USD_DIGITS)}`);

// §13.3, §15: `$0.15`; `$?` when no review had a price; `$0.15+?` when some had none.
export const costText = (cost: Cost): string => {
  if (!cost.hasUnpriced) {
    return usdText(cost.usd);
  }
  return cost.hasPrice ? `${usdText(cost.usd)}+?` : '$?';
};
