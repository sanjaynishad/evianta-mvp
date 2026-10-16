import { geminiApiKey, googleCloudLocation, googleCloudProject } from "@evianta/env";
import type { TokenUsage } from "@evianta/core";
import type { Genkit, ModelReference, Part } from "genkit";
import type { GenerateResponseData, ModelMiddleware } from "genkit/model";
import type { z } from "zod";

import { AiNonTransientError } from "./errors.js";
import type { ModelId } from "./models.js";
import type { ModelBackend, ModelCallRequest, ModelCallResult } from "./types.js";

export type GenkitProvider = "googleai" | "vertexai";

export interface GenkitRuntime {
  ai: Genkit;
  modelRef(id: ModelId): ModelReference<z.ZodTypeAny>;
  toJsonSchema(schema: ModelCallRequest["outputSchema"]): unknown;
}

async function loadRuntimeAsync(provider: GenkitProvider): Promise<GenkitRuntime> {
  const [{ genkit }, { googleAI, vertexAI }, { toJsonSchema }] = await Promise.all([
    import("genkit"),
    import("@genkit-ai/google-genai"),
    import("genkit/schema"),
  ]);

  if (provider === "vertexai") {
    const ai = genkit({
      plugins: [
        vertexAI({
          projectId: googleCloudProject || undefined,
          location: googleCloudLocation,
        }),
      ],
    });

    return {
      ai,
      modelRef: (id) => vertexAI.model(id),
      toJsonSchema: (schema) => toJsonSchema({ schema }),
    };
  }

  const ai = genkit({ plugins: [googleAI({ apiKey: geminiApiKey || undefined })] });

  return {
    ai,
    modelRef: (id) => googleAI.model(id),
    toJsonSchema: (schema) => toJsonSchema({ schema }),
  };
}

function groundedSystemPrompt(system: string, jsonSchema: unknown): string {
  return [
    system,
    "Respond with a single JSON value and nothing else (no prose, no code fences). It must conform to this JSON Schema:",
    JSON.stringify(jsonSchema),
  ].join("\n\n");
}

function candidateOf(response: GenerateResponseData) {
  return response.candidates?.[0];
}

function textOf(response: GenerateResponseData): string {
  const content = response.message?.content ?? candidateOf(response)?.message.content ?? [];

  return content
    .map((part) => (typeof part.text === "string" && !part.reasoning ? part.text : ""))
    .join("");
}

function finishReasonOf(response: GenerateResponseData): string | undefined {
  return response.finishReason ?? candidateOf(response)?.finishReason;
}

function usageOf(response: GenerateResponseData): TokenUsage {
  const input = response.usage?.inputTokens ?? 0;
  const output = (response.usage?.outputTokens ?? 0) + (response.usage?.thoughtsTokens ?? 0);

  return { input, output, total: input + output };
}

function toModelCallResult(response: GenerateResponseData): ModelCallResult {
  if (finishReasonOf(response) === "blocked") {
    const finishMessage = response.finishMessage ?? candidateOf(response)?.finishMessage;

    throw new AiNonTransientError(
      `The model blocked the response${finishMessage ? `: ${finishMessage}` : "."}`,
      { reason: "blocked", usage: usageOf(response) },
    );
  }

  return { text: textOf(response), usage: usageOf(response), raw: response.custom };
}

export function createGenkitBackend(
  provider: GenkitProvider,
  loadRuntime: () => Promise<GenkitRuntime> = () => loadRuntimeAsync(provider),
): ModelBackend {
  let runtimePromise: Promise<GenkitRuntime> | undefined;

  function getRuntimeAsync(): Promise<GenkitRuntime> {
    runtimePromise ??= loadRuntime().catch((error: unknown) => {
      runtimePromise = undefined;
      throw new AiNonTransientError(
        `Failed to initialize the ${provider} Genkit provider: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, reason: "not-configured" },
      );
    });

    return runtimePromise;
  }

  return {
    provider,
    async generateAsync(request: ModelCallRequest): Promise<ModelCallResult> {
      const runtime = await getRuntimeAsync();
      let captured: GenerateResponseData | undefined;
      const capture: ModelMiddleware = async (modelRequest, next) => {
        captured = await next(modelRequest);

        return captured;
      };

      const prompt: Part[] = request.media
        ? [{ media: request.media }, { text: request.prompt }]
        : [{ text: request.prompt }];

      // Gemini 2.5 rejects constrained JSON output combined with the search tool, so grounded
      // calls describe the schema in the prompt and the client validates the text.
      const system = request.grounding
        ? groundedSystemPrompt(request.system, runtime.toJsonSchema(request.outputSchema))
        : request.system;

      try {
        await runtime.ai.generate({
          model: runtime.modelRef(request.model),
          system,
          prompt,
          output: request.grounding ? undefined : { schema: request.outputSchema },
          config: {
            maxOutputTokens: request.maxOutputTokens,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.grounding ? { googleSearchRetrieval: {} } : {}),
          },
          use: [capture],
          abortSignal: request.signal,
        });
      } catch (error) {
        // Genkit validates and parses output after the model returns; keep the model response so
        // the client can account for its usage and apply its own retry policy.
        if (!captured) {
          throw error;
        }
      }

      if (!captured) {
        throw new AiNonTransientError("The model returned no response.");
      }

      return toModelCallResult(captured);
    },
  };
}
