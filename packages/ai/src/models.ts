import type { ModelTier } from "@evianta/core";

export const MODEL_ID_BY_TIER = {
  cheap: "gemini-2.5-flash-lite",
  mid: "gemini-2.5-flash",
  high: "gemini-2.5-pro",
} as const satisfies Record<ModelTier, string>;

export type ModelId = (typeof MODEL_ID_BY_TIER)[ModelTier];

export type VisionModelTier = Exclude<ModelTier, "high">;

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function modelForTier(tier: ModelTier): ModelId {
  return MODEL_ID_BY_TIER[tier];
}
