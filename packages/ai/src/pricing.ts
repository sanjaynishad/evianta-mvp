import type { ModelTier, TokenUsage } from "@evianta/core";

export type Cost = number;

export interface TierPrice {
  inputPer1K: number;
  outputPer1K: number;
}

// USD per 1K tokens for the models in MODEL_ID_BY_TIER (Gemini API paid tier, prompts up to 200K
// tokens). Thinking tokens are billed as output.
export const PRICE_TABLE_USD_PER_1K: Readonly<Record<ModelTier, TierPrice>> = {
  cheap: { inputPer1K: 0.0001, outputPer1K: 0.0004 },
  mid: { inputPer1K: 0.0003, outputPer1K: 0.0025 },
  high: { inputPer1K: 0.00125, outputPer1K: 0.01 },
};

const COST_PRECISION = 1e10;

export function roundCost(cost: number): Cost {
  return Math.round(cost * COST_PRECISION) / COST_PRECISION;
}

export function estimateCost(usage: TokenUsage, tier: ModelTier): Cost {
  const price = PRICE_TABLE_USD_PER_1K[tier];

  return roundCost(
    (usage.input / 1000) * price.inputPer1K + (usage.output / 1000) * price.outputPer1K,
  );
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0 };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
  };
}
