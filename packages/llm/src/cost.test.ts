import { describe, expect, it } from 'vitest';
import { estimateModelCost, type ModelPriceTable } from './cost.js';

/** Hand-checked against the placeholder rates: Haiku $1 / $5 per million, Sonnet $3 / $15. */
const prices: ModelPriceTable = {
  'claude-haiku-5-5': { input_usd_per_mtok: 1, output_usd_per_mtok: 5 },
  'claude-sonnet-5-5': { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
};

describe('estimateModelCost', () => {
  it('prices a known model from input and output tokens', () => {
    const haiku = estimateModelCost(
      'claude-haiku-5-5',
      { input_tokens: 2_000_000, output_tokens: 1_000_000 },
      prices,
    );
    expect(haiku).toEqual({ cost_usd: 7, price_configured: true });

    const sonnet = estimateModelCost(
      'claude-sonnet-5-5',
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      prices,
    );
    expect(sonnet).toEqual({ cost_usd: 18, price_configured: true });
  });

  it('reports an unknown model as unpriced instead of charging zero', () => {
    expect(estimateModelCost('fast-from-env', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices)).toEqual({
      cost_usd: null,
      price_configured: false,
    });
    expect(estimateModelCost('', { input_tokens: 10, output_tokens: 10 }, prices).cost_usd).toBeNull();
  });

  it('bills cache read and cache write tokens at the input rate', () => {
    const cost = estimateModelCost(
      'claude-haiku-5-5',
      {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 2_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      prices,
    );
    expect(cost).toEqual({ cost_usd: 4, price_configured: true });
  });

  it('treats a known model with no tokens as a known zero, not a missing price', () => {
    expect(estimateModelCost('claude-sonnet-5-5', {}, prices)).toEqual({
      cost_usd: 0,
      price_configured: true,
    });
  });
});
