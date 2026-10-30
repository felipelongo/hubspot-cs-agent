/**
 * USD per million tokens. Cache read and cache write tokens are billed at the
 * input rate. Confirm both the rates and that cache treatment against
 * Anthropic's current price list before treating a total as real spend.
 */
export interface ModelTokenPrice {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export type ModelPriceTable = Readonly<Record<string, ModelTokenPrice>>;

export interface BillableUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Tokens read from the prompt cache. Anthropic reports these separately from input_tokens. */
  cache_read_input_tokens?: number | null;
  /** Tokens written into the prompt cache (`cache_creation_input_tokens` on the SDK usage block). */
  cache_creation_input_tokens?: number | null;
}

export interface ModelCost {
  /** Null when `model` has no row in the price table. Never a silent zero. */
  cost_usd: number | null;
  price_configured: boolean;
}

export function estimateModelCost(model: string, usage: BillableUsage, prices: ModelPriceTable): ModelCost {
  const price = prices[model];
  if (!price) return { cost_usd: null, price_configured: false };
  const inputTokens =
    count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  const outputTokens = count(usage.output_tokens);
  const costUsd =
    (inputTokens * price.input_usd_per_mtok + outputTokens * price.output_usd_per_mtok) / 1_000_000;
  return { cost_usd: costUsd, price_configured: true };
}

function count(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 0) return 0;
  return value;
}
