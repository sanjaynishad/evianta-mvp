import { modelTierSchema } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { MODEL_ID_BY_TIER, modelForTier } from "./models.js";
import { addUsage, emptyUsage, estimateCost, PRICE_TABLE_USD_PER_1K } from "./pricing.js";

describe("modelForTier", () => {
  it("resolves each tier to its centralized model id", () => {
    expect(modelForTier("cheap")).toBe("gemini-2.5-flash-lite");
    expect(modelForTier("mid")).toBe("gemini-2.5-flash");
    expect(modelForTier("high")).toBe("gemini-2.5-pro");
  });

  it("covers every tier in the core schema with a model and a price", () => {
    for (const tier of modelTierSchema.options) {
      expect(MODEL_ID_BY_TIER[tier]).toBeTruthy();
      expect(PRICE_TABLE_USD_PER_1K[tier].inputPer1K).toBeGreaterThan(0);
      expect(PRICE_TABLE_USD_PER_1K[tier].outputPer1K).toBeGreaterThan(0);
    }
  });
});

describe("estimateCost", () => {
  it("prices input and output tokens per 1K for the tier", () => {
    const usage = { input: 10_000, output: 2_000, total: 12_000 };

    expect(estimateCost(usage, "cheap")).toBeCloseTo(10 * 0.0001 + 2 * 0.0004, 12);
    expect(estimateCost(usage, "mid")).toBeCloseTo(10 * 0.0003 + 2 * 0.0025, 12);
    expect(estimateCost(usage, "high")).toBeCloseTo(10 * 0.00125 + 2 * 0.01, 12);
  });

  it("returns zero for no usage and orders tiers by price", () => {
    const usage = { input: 1_000, output: 1_000, total: 2_000 };

    expect(estimateCost(emptyUsage(), "high")).toBe(0);
    expect(estimateCost(usage, "cheap")).toBeLessThan(estimateCost(usage, "mid"));
    expect(estimateCost(usage, "mid")).toBeLessThan(estimateCost(usage, "high"));
  });

  it.each([
    [199_999, 0.25999875],
    [200_000, 0.26],
    [200_001, 0.5150025],
    [250_000, 0.64],
  ])("prices a high-tier attempt with %i input tokens", (input, expectedCost) => {
    expect(estimateCost({ input, output: 1000, total: input + 1000 }, "high")).toBeCloseTo(
      expectedCost,
      10,
    );
  });

  it("keeps cheap and mid pricing unchanged above 200K input tokens", () => {
    const usage = { input: 250_000, output: 1000, total: 251_000 };

    expect(estimateCost(usage, "cheap")).toBeCloseTo(0.0254, 10);
    expect(estimateCost(usage, "mid")).toBeCloseTo(0.0775, 10);
  });

  it("is additive across attempts", () => {
    const first = { input: 120, output: 30, total: 150 };
    const second = { input: 80, output: 45, total: 125 };

    expect(addUsage(first, second)).toEqual({ input: 200, output: 75, total: 275 });
    expect(estimateCost(addUsage(first, second), "mid")).toBeCloseTo(
      estimateCost(first, "mid") + estimateCost(second, "mid"),
      12,
    );
  });
});
