import { describe, expect, it } from "vitest";
import { z } from "zod";

import { backoffDelayMs, createAiClient } from "./client.js";
import {
  AiInputValidationError,
  AiNonTransientError,
  AiOutputValidationError,
  AiTransientError,
  isTransientAiError,
  nonTransientReasonOf,
  retryAfterMsOf,
} from "./errors.js";
import { createMockAi, type MockStep } from "./mock.js";
import { estimateCost } from "./pricing.js";
import type { ModelBackend } from "./types.js";

const inputSchema = z.object({ notice: z.string().min(1) });
const outputSchema = z.object({
  summary: z.string(),
  amount: z.number().nonnegative(),
});

function request(overrides: { grounding?: boolean; key?: string; maxOutputTokens?: number } = {}) {
  return {
    tier: "mid" as const,
    key: overrides.key ?? "case-analysis",
    inputSchema,
    outputSchema,
    system: "Summarize the notice.",
    input: { notice: "Demand of 12,500 under section 143(1)." },
    ...overrides,
  };
}

const validOutput = { summary: "Demand under 143(1)", amount: 12500 };

function recordingSleep() {
  const delays: number[] = [];

  return {
    delays,
    sleepAsync: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("runStructuredAsync", () => {
  it("returns validated output with usage, cost, and model details", async () => {
    const ai = createMockAi({
      "case-analysis": { output: validOutput, usage: { input: 1200, output: 300 } },
    });

    const result = await ai.runStructuredAsync(request());

    expect(result.output).toEqual(validOutput);
    expect(result.usage).toEqual({ input: 1200, output: 300, total: 1500 });
    expect(result.cost).toBeCloseTo(estimateCost(result.usage, "mid"), 12);
    expect(result.cost).toBeGreaterThan(0);
    expect(result).toMatchObject({ tier: "mid", model: "gemini-2.5-flash", attempts: 1 });
    expect(result.citations).toBeUndefined();
    expect(result.needsVerification).toBe(false);
  });

  it("sends the parsed input, system prompt, tier model, and default output cap", async () => {
    const ai = createMockAi({ "case-analysis": { output: validOutput } });

    await ai.runStructuredAsync(request());

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({
      key: "case-analysis",
      tier: "mid",
      model: "gemini-2.5-flash",
      system: "Summarize the notice.",
      grounding: false,
      maxOutputTokens: 4096,
    });
    expect(JSON.parse(ai.calls[0]?.prompt ?? "")).toEqual({
      notice: "Demand of 12,500 under section 143(1).",
    });
  });

  it("returns synthetic usage derived from prompt and output sizes when none is scripted", async () => {
    const ai = createMockAi({ "case-analysis": { output: validOutput } });

    const first = await ai.runStructuredAsync(request());
    const second = await ai.runStructuredAsync(request());

    expect(first.usage.input).toBeGreaterThan(0);
    expect(first.usage.output).toBe(Math.ceil(JSON.stringify(validOutput).length / 4));
    expect(first.usage.total).toBe(first.usage.input + first.usage.output);
    expect(second.usage).toEqual(first.usage);
  });

  it("sends an empty string prompt for a valid no-input request", async () => {
    const ai = createMockAi({ "case-analysis": { output: validOutput } });

    const result = await ai.runStructuredAsync({
      ...request(),
      inputSchema: z.void(),
      input: undefined,
    });

    expect(result.output).toEqual(validOutput);
    expect(ai.calls[0]?.prompt).toBe("");
  });

  it("falls back to the wildcard script and honors a custom output cap", async () => {
    const ai = createMockAi({ "*": { output: validOutput } });

    await ai.runStructuredAsync(request({ key: "unscripted", maxOutputTokens: 512 }));

    expect(ai.calls[0]?.maxOutputTokens).toBe(512);
  });

  it("rejects input that does not match the input schema without calling the model", async () => {
    const ai = createMockAi({ "case-analysis": { output: validOutput } });

    await expect(
      ai.runStructuredAsync({ ...request(), input: { notice: "" } }),
    ).rejects.toBeInstanceOf(AiInputValidationError);
    expect(ai.calls).toHaveLength(0);
  });

  it("throws AiOutputValidationError after one retry when output stays invalid", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { output: { summary: "missing amount" }, usage: { input: 100, output: 10 } },
        { text: "not json at all", usage: { input: 100, output: 5 } },
        { output: validOutput },
      ],
    });

    const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiOutputValidationError);
    expect(error).toMatchObject({
      attempts: 2,
      usage: { input: 200, output: 15, total: 215 },
      rawText: "not json at all",
    });
    expect((error as AiOutputValidationError).issues[0]).toMatch(/not valid JSON/);
    expect((error as AiOutputValidationError).cost).toBeGreaterThan(0);
    expect(ai.calls).toHaveLength(2);
  });

  it("retries one invalid output and succeeds, summing usage", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { output: { summary: "bad", amount: -1 }, usage: { input: 100, output: 20 } },
        { output: validOutput, usage: { input: 110, output: 25 } },
      ],
    });

    const result = await ai.runStructuredAsync(request());

    expect(result.output).toEqual(validOutput);
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ input: 210, output: 45, total: 255 });
  });

  it("parses JSON wrapped in a code fence", async () => {
    const ai = createMockAi({
      "case-analysis": { text: `Here you go:\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\`` },
    });

    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({ output: validOutput });
  });
});

describe("retries", () => {
  it("retries a transient failure and sums usage across attempts", async () => {
    const sleep = recordingSleep();
    const ai = createMockAi(
      {
        "case-analysis": [
          { error: "transient" },
          { output: { summary: "bad" }, usage: { input: 90, output: 10 } },
          { output: validOutput, usage: { input: 100, output: 30 } },
        ],
      },
      { sleepAsync: sleep.sleepAsync },
    );

    const result = await ai.runStructuredAsync(request());

    expect(result.output).toEqual(validOutput);
    expect(result.attempts).toBe(3);
    expect(result.usage).toEqual({ input: 190, output: 40, total: 230 });
    expect(result.cost).toBeCloseTo(estimateCost(result.usage, "mid"), 12);
    expect(sleep.delays).toHaveLength(1);
  });

  it("does not retry a non-transient failure", async () => {
    const sleep = recordingSleep();
    const ai = createMockAi(
      { "case-analysis": [{ error: "non-transient" }, { output: validOutput }] },
      { sleepAsync: sleep.sleepAsync },
    );

    const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiNonTransientError);
    expect(error).toMatchObject({ attempts: 1, reason: "invalid-request" });
    expect(ai.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
  });

  it("stops after two retries and reports a transient error", async () => {
    const sleep = recordingSleep();
    const ai = createMockAi(
      {
        "case-analysis": [
          { error: "transient" },
          { error: "transient" },
          { error: "transient" },
          { output: validOutput },
        ],
      },
      { sleepAsync: sleep.sleepAsync, baseDelayMs: 100, random: () => 0.5 },
    );

    const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiTransientError);
    expect(error).toMatchObject({ attempts: 3 });
    expect(ai.calls).toHaveLength(3);
    expect(sleep.delays).toEqual([150, 250]);
  });

  it("does not spend more than two retries when a parse failure follows transient failures", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { error: "transient" },
        { error: "transient" },
        { text: "{" },
        { output: validOutput },
      ],
    });

    await expect(ai.runStructuredAsync(request())).rejects.toBeInstanceOf(AiOutputValidationError);
    expect(ai.calls).toHaveLength(3);
  });

  it("classifies provider errors by status", async () => {
    const rateLimited = Object.assign(new Error("RESOURCE_EXHAUSTED: [429 Too Many Requests]"), {
      status: "RESOURCE_EXHAUSTED",
      responseMetadata: { retryAfterMs: 2000 },
    });
    const badRequest = Object.assign(new Error("INVALID_ARGUMENT: [400 Bad Request]"), {
      status: "INVALID_ARGUMENT",
    });
    const sleep = recordingSleep();
    const steps: MockStep[] = [{ error: rateLimited }, { output: validOutput }];
    const ai = createMockAi({ "case-analysis": steps }, { sleepAsync: sleep.sleepAsync });

    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({ attempts: 2 });
    expect(sleep.delays).toEqual([2000]);

    ai.script("case-analysis", { error: badRequest }, { output: validOutput });

    await expect(ai.runStructuredAsync(request())).rejects.toMatchObject({
      name: "AiNonTransientError",
      reason: "invalid-request",
      attempts: 1,
    });
  });

  it("treats a timed out attempt as transient", async () => {
    let calls = 0;
    const backend: ModelBackend = {
      provider: "mock",
      generateAsync: async () => {
        calls += 1;

        if (calls === 1) {
          return new Promise(() => {});
        }

        return { text: JSON.stringify(validOutput), usage: { input: 1, output: 1, total: 2 } };
      },
    };
    const ai = createAiClient(backend, { timeoutMs: 10, sleepAsync: async () => {} });

    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({ attempts: 2 });
  });

  it("keeps a timeout transient when the backend rejects from its abort listener", async () => {
    let calls = 0;
    const backend: ModelBackend = {
      provider: "mock",
      generateAsync: ({ signal }) => {
        calls += 1;

        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
              );
            });
          });
        }

        return Promise.resolve({
          text: JSON.stringify(validOutput),
          usage: { input: 1, output: 1, total: 2 },
        });
      },
    };
    const ai = createAiClient(backend, { timeoutMs: 10, sleepAsync: async () => {} });

    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({ attempts: 2 });
  });

  it("waits for a provider retry-after longer than the backoff cap", async () => {
    const sleep = recordingSleep();
    const ai = createMockAi(
      {
        "case-analysis": [{ error: "transient", retryAfterMs: 60_000 }, { output: validOutput }],
      },
      { sleepAsync: sleep.sleepAsync },
    );

    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({ attempts: 2 });
    expect(sleep.delays).toEqual([60_000]);
  });

  it("fails without waiting when the retry-after exceeds maxRetryAfterMs", async () => {
    const sleep = recordingSleep();
    const ai = createMockAi(
      {
        "case-analysis": [{ error: "transient", retryAfterMs: 300_000 }, { output: validOutput }],
      },
      { sleepAsync: sleep.sleepAsync, maxRetryAfterMs: 120_000 },
    );

    const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiTransientError);
    expect(error).toMatchObject({ attempts: 1, retryAfterMs: 300_000 });
    expect((error as AiTransientError).message).toMatch(/retry after 300000 ms/);
    expect(sleep.delays).toEqual([]);
    expect(ai.calls).toHaveLength(1);
  });

  it.each([0, 1, 2])(
    "preserves the terminal retry-after with maxRetries=%i",
    async (maxRetries) => {
      const sleep = recordingSleep();
      const ai = createMockAi(
        { "case-analysis": { error: "transient", retryAfterMs: 2000 } },
        { maxRetries, sleepAsync: sleep.sleepAsync },
      );

      const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiTransientError);
      expect(error).toMatchObject({ attempts: maxRetries + 1, retryAfterMs: 2000 });
      expect(retryAfterMsOf(error)).toBe(2000);
      expect(sleep.delays).toEqual(Array.from({ length: maxRetries }, () => 2000));
      expect(ai.calls).toHaveLength(maxRetries + 1);
    },
  );

  it.each([0, 2000])(
    "preserves a provider's terminal retry-after of %i ms",
    async (retryAfterMs) => {
      const providerError = Object.assign(new Error("Rate limited"), {
        status: 429,
        responseMetadata: { retryAfterMs },
      });
      const ai = createMockAi({ "case-analysis": { error: providerError } }, { maxRetries: 0 });

      const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiTransientError);
      expect(retryAfterMsOf(error)).toBe(retryAfterMs);
      expect(error).toMatchObject({ cause: providerError, attempts: 1 });
    },
  );

  it("sums usage from a usage-bearing transient failure with the successful attempt", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { error: "transient", usage: { input: 40, output: 5 } },
        { output: validOutput, usage: { input: 100, output: 30 } },
      ],
    });

    const result = await ai.runStructuredAsync(request());

    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ input: 140, output: 35, total: 175 });
    expect(result.cost).toBeCloseTo(estimateCost(result.usage, "mid"), 12);
  });

  it("keeps usage and cost from earlier attempts and a usage-bearing final failure", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { error: "transient", usage: { input: 40, output: 5 } },
        { error: "non-transient", usage: { input: 60, output: 10 } },
      ],
    });

    const error = await ai.runStructuredAsync(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiNonTransientError);
    expect(error).toMatchObject({ attempts: 2, usage: { input: 100, output: 15, total: 115 } });
    expect((error as AiNonTransientError).cost).toBeCloseTo(
      estimateCost({ input: 100, output: 15, total: 115 }, "mid"),
      12,
    );
  });
});

describe("isTransientAiError", () => {
  it.each([
    [{ status: "UNAVAILABLE" }, true],
    [{ status: "DEADLINE_EXCEEDED" }, true],
    [{ status: "INTERNAL" }, true],
    [Object.assign(new Error("UNKNOWN: [502 Bad Gateway]"), { status: "UNKNOWN" }), true],
    [Object.assign(new Error("UNKNOWN: [418 Teapot]"), { status: "UNKNOWN" }), false],
    [Object.assign(new Error("fetch failed"), { status: "UNKNOWN" }), true],
    [
      Object.assign(new Error("connection failed", { cause: { code: "ECONNRESET" } }), {
        status: "UNKNOWN",
      }),
      true,
    ],
    [Object.assign(new Error("connection failed"), { status: "UNKNOWN", code: "ETIMEDOUT" }), true],
    [Object.assign(new Error("unrecognized failure"), { status: "UNKNOWN" }), false],
    [
      Object.assign(new Error("UNKNOWN: [400 Bad Request] fetch failed"), { status: "UNKNOWN" }),
      false,
    ],
    [{ status: "INVALID_ARGUMENT" }, false],
    [{ status: "PERMISSION_DENIED" }, false],
    [{ status: 503 }, true],
    [{ statusCode: 429 }, true],
    [{ status: 400 }, false],
    [Object.assign(new Error("socket"), { code: "ECONNRESET" }), true],
    [new Error("Failed to fetch from https://example: fetch failed"), true],
    [Object.assign(new Error("timeout"), { name: "TimeoutError" }), true],
    [new Error("something else"), false],
    [new AiTransientError("x"), true],
    [new AiNonTransientError("x"), false],
  ])("classifies %o as transient=%s", (error, expected) => {
    expect(isTransientAiError(error)).toBe(expected);
  });
});

describe("nonTransientReasonOf", () => {
  it.each(["status", "statusCode"])("classifies numeric HTTP errors from %s", async (field) => {
    const cases = [
      [400, "invalid-request"],
      [401, "permission-denied"],
      [403, "permission-denied"],
      [404, "invalid-request"],
      [412, "invalid-request"],
      [418, "unknown"],
    ] as const;

    for (const [status, reason] of cases) {
      const providerError = Object.assign(new Error(`HTTP ${status}`), { [field]: status });
      const ai = createMockAi({ "case-analysis": { error: providerError } });

      expect(nonTransientReasonOf(providerError)).toBe(reason);
      await expect(ai.runStructuredAsync(request())).rejects.toMatchObject({
        name: "AiNonTransientError",
        reason,
        attempts: 1,
        cause: providerError,
      });
      expect(ai.calls).toHaveLength(1);
    }
  });

  it.each([
    ["INVALID_ARGUMENT", "invalid-request"],
    ["FAILED_PRECONDITION", "invalid-request"],
    ["NOT_FOUND", "invalid-request"],
    ["PERMISSION_DENIED", "permission-denied"],
    ["UNAUTHENTICATED", "permission-denied"],
    ["UNKNOWN", "unknown"],
  ] as const)("preserves named status %s as %s", (status, reason) => {
    expect(nonTransientReasonOf({ status })).toBe(reason);
  });

  it("preserves an explicitly classified error reason", () => {
    expect(nonTransientReasonOf(new AiNonTransientError("Blocked", { reason: "blocked" }))).toBe(
      "blocked",
    );
  });
});

describe("high-tier cost accounting", () => {
  it("charges long-context rates for a successful attempt", async () => {
    const ai = createMockAi({
      "case-analysis": { output: validOutput, usage: { input: 250_000, output: 1000 } },
    });

    const result = await ai.runStructuredAsync({ ...request(), tier: "high" });

    expect(result.cost).toBeCloseTo(0.64, 10);
  });

  it.each([false, true])(
    "does not apply long-context rates to combined short attempts (invalid output: %s)",
    async (invalidOutput) => {
      const usage = { input: 120_000, output: 1000 };
      const firstStep: MockStep = invalidOutput
        ? { output: { summary: "missing amount" }, usage }
        : { error: "transient", usage };
      const ai = createMockAi({
        "case-analysis": [firstStep, { output: validOutput, usage }],
      });

      const result = await ai.runStructuredAsync({ ...request(), tier: "high" });

      expect(result.attempts).toBe(2);
      expect(result.usage).toEqual({ input: 240_000, output: 2000, total: 242_000 });
      expect(result.cost).toBeCloseTo(0.32, 10);
    },
  );

  it("prices long and short attempts separately when recovering from a transient failure", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { error: "transient", usage: { input: 250_000, output: 1000 } },
        { output: validOutput, usage: { input: 100_000, output: 1000 } },
      ],
    });

    const result = await ai.runStructuredAsync({ ...request(), tier: "high" });

    expect(result.usage).toEqual({ input: 350_000, output: 2000, total: 352_000 });
    expect(result.cost).toBeCloseTo(0.775, 10);
  });

  it.each(["transient", "non-transient"] as const)(
    "preserves per-attempt costs on a final %s failure",
    async (error) => {
      const ai = createMockAi(
        {
          "case-analysis": [
            { error: "transient", usage: { input: 120_000, output: 1000 } },
            { error, usage: { input: 250_000, output: 1000 } },
          ],
        },
        { maxRetries: 1 },
      );

      await expect(ai.runStructuredAsync({ ...request(), tier: "high" })).rejects.toMatchObject({
        name: error === "transient" ? "AiTransientError" : "AiNonTransientError",
        attempts: 2,
        usage: { input: 370_000, output: 2000, total: 372_000 },
        cost: 0.8,
      });
    },
  );

  it("preserves short-attempt costs when output validation exhausts retries", async () => {
    const ai = createMockAi({
      "case-analysis": {
        output: { summary: "missing amount" },
        usage: { input: 120_000, output: 1000 },
      },
    });

    await expect(ai.runStructuredAsync({ ...request(), tier: "high" })).rejects.toMatchObject({
      name: "AiOutputValidationError",
      attempts: 2,
      usage: { input: 240_000, output: 2000, total: 242_000 },
      cost: 0.32,
    });
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially with capped jitter and uses retry-after as an uncapped minimum", () => {
    const settings = { baseDelayMs: 500, maxDelayMs: 8000, random: () => 0.2 };

    expect(backoffDelayMs(0, settings)).toBe(600);
    expect(backoffDelayMs(1, settings)).toBe(1100);
    expect(backoffDelayMs(2, settings)).toBe(2100);
    expect(backoffDelayMs(10, settings)).toBe(8000);
    expect(backoffDelayMs(0, settings, 3000)).toBe(3000);
    expect(backoffDelayMs(0, settings, 100)).toBe(600);
    // maxDelayMs caps only the computed backoff; runModelAsync rejects retry-after values above
    // maxRetryAfterMs instead of shortening them.
    expect(backoffDelayMs(0, settings, 60_000)).toBe(60_000);
  });
});

describe("grounding", () => {
  it("returns citations from the grounding response when grounding is requested", async () => {
    const ai = createMockAi({
      "tax-research": {
        output: validOutput,
        citations: [
          { title: "Income-tax Act", url: "https://example.gov/act", snippet: "Section 143(1)" },
        ],
      },
    });

    const result = await ai.runStructuredAsync(request({ key: "tax-research", grounding: true }));

    expect(ai.calls[0]?.grounding).toBe(true);
    expect(result.citations).toEqual([
      { title: "Income-tax Act", url: "https://example.gov/act", snippet: "Section 143(1)" },
    ]);
    expect(result.needsVerification).toBe(false);
  });

  it("flags results that need verification when grounding returns no citations", async () => {
    const ai = createMockAi({ "tax-research": { output: validOutput } });

    const result = await ai.runStructuredAsync(request({ key: "tax-research", grounding: true }));

    expect(result.citations).toEqual([]);
    expect(result.needsVerification).toBe(true);
  });
});

describe("mock provider", () => {
  it("fails with a non-transient error when no output is scripted", async () => {
    const ai = createMockAi();

    await expect(ai.runStructuredAsync(request())).rejects.toMatchObject({
      name: "AiNonTransientError",
      reason: "not-configured",
    });
  });

  it("repeats the last step, and reset rewinds the script and clears calls", async () => {
    const ai = createMockAi({
      "case-analysis": [
        { output: { summary: "first", amount: 1 } },
        { output: { summary: "last", amount: 2 } },
      ],
    });

    const outputs = [];

    for (let index = 0; index < 3; index += 1) {
      outputs.push((await ai.runStructuredAsync(request())).output.summary);
    }

    expect(outputs).toEqual(["first", "last", "last"]);

    ai.reset();

    expect(ai.calls).toHaveLength(0);
    await expect(ai.runStructuredAsync(request())).resolves.toMatchObject({
      output: { summary: "first" },
    });
  });
});
