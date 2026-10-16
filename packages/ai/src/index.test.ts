import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAi,
  createMockAi,
  extractFromImageAsync,
  getAi,
  mockImageExtractionStep,
  runStructuredAsync,
  setAi,
} from "./index.js";

afterEach(() => {
  setAi(undefined);
});

describe("createAi", () => {
  it("creates a scripted mock client for the mock provider", async () => {
    const ai = createAi("mock", { mockScript: { coordinator: { output: { ok: true } } } });

    expect(ai.provider).toBe("mock");
    await expect(
      ai.runStructuredAsync({
        tier: "cheap",
        key: "coordinator",
        inputSchema: z.string(),
        outputSchema: z.object({ ok: z.boolean() }),
        system: "Plan.",
        input: "case",
      }),
    ).resolves.toMatchObject({ output: { ok: true } });
  });

  it("creates Genkit-backed clients lazily without credentials", () => {
    expect(createAi("googleai").provider).toBe("googleai");
    expect(createAi("vertexai").provider).toBe("vertexai");
  });
});

describe("shared client", () => {
  it("routes top-level helpers through the client set with setAi", async () => {
    const mock = createMockAi({
      planner: { output: { steps: 2 } },
      "extract-from-image": mockImageExtractionStep({ text: "scan", confidence: 0.7 }),
    });
    setAi(mock);

    expect(getAi()).toBe(mock);
    await expect(
      runStructuredAsync({
        tier: "mid",
        key: "planner",
        inputSchema: z.object({ caseId: z.string() }),
        outputSchema: z.object({ steps: z.number() }),
        system: "Plan.",
        input: { caseId: "case-1" },
      }),
    ).resolves.toMatchObject({ output: { steps: 2 } });
    await expect(
      extractFromImageAsync({ image: "AAAA", mimeType: "image/png" }),
    ).resolves.toMatchObject({ text: "scan", method: "ocr" });
  });
});
