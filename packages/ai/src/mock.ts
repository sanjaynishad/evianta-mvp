import type { CitationInput, TextSpan, TokenUsage } from "@evianta/core";

import { createAiClient, type AiClientOptions } from "./client.js";
import { AiNonTransientError, AiTransientError } from "./errors.js";
import type { ImageExtractionModelOutput } from "./image.js";
import type { AiClient, ModelBackend, ModelCallRequest, ModelCallResult } from "./types.js";

export const MOCK_FALLBACK_KEY = "*";

export const MOCK_IMAGE_TOKENS = 258;

export type MockStep =
  | {
      output: unknown;
      usage?: Partial<TokenUsage>;
      citations?: CitationInput[];
      /** Raw provider response with grounding metadata; overrides `citations`. */
      groundingResponse?: unknown;
    }
  | {
      text: string;
      usage?: Partial<TokenUsage>;
      groundingResponse?: unknown;
      finishReason?: string;
      outputTokens?: number;
      thinkingTokens?: number;
    }
  | {
      error: "transient" | "non-transient" | Error;
      message?: string;
      retryAfterMs?: number;
      /** Usage billed for the failed attempt, for example a blocked response. */
      usage?: Partial<TokenUsage>;
    };

/** Steps are served in order per key; the last step repeats once the list is exhausted. */
export type MockScript = Record<string, MockStep | readonly MockStep[]>;

export type MockCall = Omit<ModelCallRequest, "signal" | "outputSchema">;

export interface MockAiClient extends AiClient {
  readonly provider: "mock";
  readonly calls: readonly MockCall[];
  /** Replaces the steps for a key and rewinds it. */
  script(key: string, ...steps: MockStep[]): void;
  reset(): void;
}

export function estimateMockTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function completeUsage(usage: Partial<TokenUsage>): TokenUsage {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;

  return { input, output, total: usage.total ?? input + output };
}

function syntheticUsage(call: ModelCallRequest, text: string, override?: Partial<TokenUsage>) {
  const input =
    override?.input ??
    estimateMockTokens(call.system) +
      estimateMockTokens(call.prompt) +
      (call.media ? MOCK_IMAGE_TOKENS : 0);
  const output = override?.output ?? estimateMockTokens(text);

  return { input, output, total: override?.total ?? input + output };
}

function groundingResponseFor(citations: CitationInput[]): unknown {
  return {
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: citations.map((citation) => ({
            web: { uri: citation.url, title: citation.title },
          })),
          groundingSupports: citations.flatMap((citation, index) =>
            citation.snippet
              ? [{ segment: { text: citation.snippet }, groundingChunkIndices: [index] }]
              : [],
          ),
        },
      },
    ],
  };
}

function toSteps(entry: MockStep | readonly MockStep[]): readonly MockStep[] {
  return Array.isArray(entry) ? entry : [entry as MockStep];
}

function createMockBackend(initialScript: MockScript) {
  const steps = new Map<string, readonly MockStep[]>();
  const cursors = new Map<string, number>();
  const calls: MockCall[] = [];

  for (const [key, entry] of Object.entries(initialScript)) {
    steps.set(key, toSteps(entry));
  }

  function nextStep(key: string | undefined): MockStep {
    const resolvedKey =
      key !== undefined && steps.has(key)
        ? key
        : steps.has(MOCK_FALLBACK_KEY)
          ? MOCK_FALLBACK_KEY
          : undefined;
    const keySteps = resolvedKey === undefined ? undefined : steps.get(resolvedKey);

    if (resolvedKey === undefined || !keySteps || keySteps.length === 0) {
      throw new AiNonTransientError(`No mock output scripted for key "${key ?? "(none)"}".`, {
        reason: "not-configured",
      });
    }

    const cursor = cursors.get(resolvedKey) ?? 0;
    cursors.set(resolvedKey, cursor + 1);

    return keySteps[Math.min(cursor, keySteps.length - 1)] as MockStep;
  }

  const backend: ModelBackend = {
    provider: "mock",
    async generateAsync(call: ModelCallRequest): Promise<ModelCallResult> {
      calls.push({
        key: call.key,
        tier: call.tier,
        model: call.model,
        system: call.system,
        prompt: call.prompt,
        media: call.media,
        grounding: call.grounding,
        outputFormat: call.outputFormat,
        maxOutputTokens: call.maxOutputTokens,
        temperature: call.temperature,
      });
      const scriptKey =
        call.outputFormat === "text" && call.key?.endsWith(":research") && !steps.has(call.key)
          ? call.key.slice(0, -":research".length)
          : call.key;
      const step = nextStep(scriptKey);

      if ("error" in step) {
        if (step.error instanceof Error) {
          throw step.error;
        }

        const usage = step.usage ? completeUsage(step.usage) : undefined;

        if (step.error === "transient") {
          throw new AiTransientError(step.message ?? "Mock transient failure (503 UNAVAILABLE).", {
            retryAfterMs: step.retryAfterMs,
            usage,
          });
        }

        throw new AiNonTransientError(
          step.message ?? "Mock non-transient failure (400 INVALID_ARGUMENT).",
          { reason: "invalid-request", usage },
        );
      }

      const text = "text" in step ? step.text : JSON.stringify(step.output);
      const raw =
        step.groundingResponse ??
        ("citations" in step && step.citations ? groundingResponseFor(step.citations) : undefined);

      return {
        text,
        usage: syntheticUsage(call, text, step.usage),
        raw,
        ...("text" in step
          ? {
              finishReason: step.finishReason,
              outputTokens: step.outputTokens,
              thinkingTokens: step.thinkingTokens,
            }
          : {}),
      };
    },
  };

  return {
    backend,
    calls,
    script(key: string, ...keySteps: MockStep[]) {
      steps.set(key, keySteps);
      cursors.delete(key);
    },
    reset() {
      calls.length = 0;
      cursors.clear();
    },
  };
}

export function createMockAi(script: MockScript = {}, options: AiClientOptions = {}): MockAiClient {
  const mock = createMockBackend(script);
  const client = createAiClient(mock.backend, {
    sleepAsync: async () => {},
    random: () => 0,
    ...options,
  });

  return {
    ...client,
    provider: "mock",
    calls: mock.calls,
    script: mock.script,
    reset: mock.reset,
  };
}

export function mockImageExtractionStep(result: {
  text: string;
  confidence: number;
  handwriting?: boolean;
  lines?: Pick<TextSpan, "text" | "bbox">[];
  usage?: Partial<TokenUsage>;
}): MockStep {
  const output: ImageExtractionModelOutput = {
    text: result.text,
    confidence: result.confidence,
    handwriting: result.handwriting ?? false,
    lines: (result.lines ?? []).map(({ text, bbox }) => ({
      text,
      box_2d: [bbox.y, bbox.x, bbox.y + bbox.height, bbox.x + bbox.width].map((value) =>
        Math.round(value * 1000),
      ),
    })),
  };

  return { output, usage: result.usage };
}
