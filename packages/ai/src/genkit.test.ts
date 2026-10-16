import { readFileSync } from "node:fs";

import { genkit, GenkitError, type GenerateRequest, type ModelResponseData } from "genkit";
import { modelRef } from "genkit/model";
import { toJsonSchema } from "genkit/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAiClient } from "./client.js";
import { AiNonTransientError, isTransientAiError } from "./errors.js";
import { createGenkitBackend, type GenkitRuntime } from "./genkit.js";
import { estimateCost } from "./pricing.js";
import type { ModelCallRequest } from "./types.js";

const groundingResponse: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/grounding-response.json", import.meta.url), "utf8"),
);

const outputSchema = z.object({ answer: z.string() });

type FakeModelHandler = (
  request: GenerateRequest,
) => ModelResponseData | Promise<ModelResponseData>;

function fakeRuntime(handler: FakeModelHandler) {
  const requests: GenerateRequest[] = [];
  const ai = genkit({});

  ai.defineModel(
    {
      name: "fake/gemini-2.5-flash",
      supports: { media: true, systemRole: true, output: ["json", "text"], constrained: "all" },
    },
    async (request) => {
      requests.push(request);

      return handler(request);
    },
  );

  const runtime: GenkitRuntime = {
    ai,
    modelRef: (id) => modelRef({ name: `fake/${id}` }),
    toJsonSchema: (schema) => toJsonSchema({ schema }),
  };

  return { runtime, requests };
}

function textResponse(text: string, extra: Partial<ModelResponseData> = {}): ModelResponseData {
  return {
    message: { role: "model", content: [{ text }] },
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, thoughtsTokens: 30 },
    ...extra,
  };
}

function callRequest(overrides: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    tier: "mid",
    model: "gemini-2.5-flash",
    system: "Answer the question.",
    prompt: "When is the deadline?",
    outputSchema,
    grounding: false,
    maxOutputTokens: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("createGenkitBackend", () => {
  it("requests constrained JSON with the output cap and folds thinking tokens into output", async () => {
    const { runtime, requests } = fakeRuntime(() => textResponse('{"answer":"30 days"}'));
    const backend = createGenkitBackend("googleai", async () => runtime);

    const result = await backend.generateAsync(callRequest({ temperature: 0.2 }));

    expect(result.text).toBe('{"answer":"30 days"}');
    expect(result.usage).toEqual({ input: 100, output: 50, total: 150 });
    expect(requests[0]?.config).toEqual({ maxOutputTokens: 1024, temperature: 0.2 });
    expect(requests[0]?.output?.schema).toBeDefined();
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: [{ text: "Answer the question." }],
    });
  });

  it("enables Google Search grounding without constrained output and returns the raw response", async () => {
    const { runtime, requests } = fakeRuntime(() =>
      textResponse('{"answer":"nine months"}', { custom: groundingResponse }),
    );
    const backend = createGenkitBackend("googleai", async () => runtime);

    const result = await backend.generateAsync(callRequest({ grounding: true }));

    expect(requests[0]?.config).toEqual({ maxOutputTokens: 1024, googleSearchRetrieval: {} });
    expect(requests[0]?.output?.schema).toBeUndefined();
    expect(JSON.stringify(requests[0]?.messages[0])).toContain("JSON Schema");
    expect(result.raw).toEqual(groundingResponse);
  });

  it("sends media parts before the prompt text", async () => {
    const { runtime, requests } = fakeRuntime(() => textResponse('{"answer":"ok"}'));
    const backend = createGenkitBackend("vertexai", async () => runtime);
    const media = { url: "data:image/png;base64,AAAA", contentType: "image/png" };

    await backend.generateAsync(callRequest({ media }));

    expect(requests[0]?.messages.at(-1)?.content).toEqual([
      { media },
      { text: "When is the deadline?" },
    ]);
  });

  it("returns the model text and usage when Genkit rejects the output schema", async () => {
    const { runtime } = fakeRuntime(() => textResponse('{"wrong":true}'));
    const backend = createGenkitBackend("googleai", async () => runtime);

    await expect(backend.generateAsync(callRequest())).resolves.toEqual({
      text: '{"wrong":true}',
      usage: { input: 100, output: 50, total: 150 },
      raw: undefined,
    });
  });

  it("raises a non-transient error when the response is blocked", async () => {
    const { runtime } = fakeRuntime(() =>
      textResponse("", { finishReason: "blocked", finishMessage: "SAFETY" }),
    );
    const backend = createGenkitBackend("googleai", async () => runtime);

    await expect(backend.generateAsync(callRequest())).rejects.toMatchObject({
      name: "AiNonTransientError",
      reason: "blocked",
    });
  });

  it("propagates provider errors so the client can classify them", async () => {
    const { runtime } = fakeRuntime(() => {
      throw new GenkitError({ status: "RESOURCE_EXHAUSTED", message: "[429 Too Many Requests]" });
    });
    const backend = createGenkitBackend("googleai", async () => runtime);

    const error = await backend.generateAsync(callRequest()).catch((caught: unknown) => caught);

    expect(isTransientAiError(error)).toBe(true);
  });

  it("reports a configuration error when the runtime cannot be loaded", async () => {
    const backend = createGenkitBackend("googleai", async () => {
      throw new Error("missing API key");
    });

    const error = await backend.generateAsync(callRequest()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiNonTransientError);
    expect(error).toMatchObject({ reason: "not-configured" });
  });

  it("charges the usage of a blocked first attempt to the client error", async () => {
    const { runtime, requests } = fakeRuntime(() =>
      textResponse("", { finishReason: "blocked", finishMessage: "SAFETY" }),
    );
    const ai = createAiClient(createGenkitBackend("googleai", async () => runtime));

    const error = await ai
      .runStructuredAsync({
        tier: "mid",
        inputSchema: z.string(),
        outputSchema,
        system: "Answer.",
        input: "question",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiNonTransientError);
    expect(error).toMatchObject({
      reason: "blocked",
      attempts: 1,
      usage: { input: 100, output: 50, total: 150 },
    });
    expect((error as AiNonTransientError).cost).toBeCloseTo(
      estimateCost({ input: 100, output: 50, total: 150 }, "mid"),
      12,
    );
    expect(requests).toHaveLength(1);
  });

  it("runs a grounded structured call end to end through the client", async () => {
    const { runtime } = fakeRuntime(() =>
      textResponse('```json\n{"answer":"nine months"}\n```', { custom: groundingResponse }),
    );
    const ai = createAiClient(createGenkitBackend("googleai", async () => runtime));

    const result = await ai.runStructuredAsync({
      tier: "mid",
      key: "tax-research",
      inputSchema: z.object({ question: z.string() }),
      outputSchema,
      system: "Research the deadline.",
      input: { question: "Deadline for a 143(1) intimation?" },
      grounding: true,
    });

    expect(result.output).toEqual({ answer: "nine months" });
    expect(result.citations).toHaveLength(2);
    expect(result.needsVerification).toBe(false);
    expect(result.usage).toEqual({ input: 100, output: 50, total: 150 });
  });
});
