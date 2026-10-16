import type { TokenUsage } from "@evianta/core";
import type { z } from "zod";

import {
  AiError,
  AiInputValidationError,
  AiNonTransientError,
  AiOutputValidationError,
  AiTransientError,
  isTransientAiError,
  nonTransientReasonOf,
  retryAfterMsOf,
} from "./errors.js";
import { extractCitations } from "./grounding.js";
import {
  DEFAULT_IMAGE_MAX_OUTPUT_TOKENS,
  HANDWRITING_CONFIDENCE_CAP,
  IMAGE_EXTRACTION_KEY,
  imageExtractionModelOutputSchema,
  imageExtractionSystemPrompt,
  toImageMedia,
  toTextSpans,
} from "./image.js";
import { parseJsonText } from "./json.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, modelForTier } from "./models.js";
import { addUsage, emptyUsage, estimateCost } from "./pricing.js";
import type {
  AiClient,
  ImageExtractionRequest,
  ImageExtractionResult,
  ModelBackend,
  ModelCallRequest,
  ModelCallResult,
  RunStructuredRequest,
  RunStructuredResult,
} from "./types.js";

export interface AiClientOptions {
  /** Retries after the first attempt. Defaults to 2. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Caps the computed exponential backoff, not a provider retry-after. */
  maxDelayMs?: number;
  /** Longest provider retry-after to wait for; a longer one fails the call instead. */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout; a timeout counts as a transient failure. */
  timeoutMs?: number;
  defaultMaxOutputTokens?: number;
  sleepAsync?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1), used for backoff jitter. */
  random?: () => number;
}

export const DEFAULT_RETRY_SETTINGS = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxRetryAfterMs: 120_000,
  timeoutMs: 120_000,
} as const;

interface ClientSettings {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  timeoutMs: number;
  defaultMaxOutputTokens: number;
  sleepAsync: (ms: number) => Promise<void>;
  random: () => number;
}

function defaultSleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSettings(options: AiClientOptions): ClientSettings {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_RETRY_SETTINGS.maxRetries,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_SETTINGS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_SETTINGS.maxDelayMs,
    maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_RETRY_SETTINGS.maxRetryAfterMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_RETRY_SETTINGS.timeoutMs,
    defaultMaxOutputTokens: options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    sleepAsync: options.sleepAsync ?? defaultSleepAsync,
    random: options.random ?? Math.random,
  };
}

export function backoffDelayMs(
  retryIndex: number,
  settings: Pick<ClientSettings, "baseDelayMs" | "maxDelayMs" | "random">,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(settings.maxDelayMs, settings.baseDelayMs * 2 ** retryIndex);
  const jittered = Math.min(
    settings.maxDelayMs,
    exponential + Math.floor(settings.random() * settings.baseDelayMs),
  );

  return Math.max(jittered, retryAfterMs ?? 0);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
}

type OutputValidation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function validateOutput<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): OutputValidation<T> {
  const parsed = parseJsonText(text);

  if (!parsed.ok) {
    return { ok: false, issues: [`Output is not valid JSON: ${parsed.error}`] };
  }

  const validated = schema.safeParse(parsed.value);

  return validated.success
    ? { ok: true, value: validated.data }
    : { ok: false, issues: formatIssues(validated.error) };
}

async function callWithTimeoutAsync(
  backend: ModelBackend,
  call: Omit<ModelCallRequest, "signal">,
  timeoutMs: number,
): Promise<ModelCallResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so a backend that rejects from its abort listener cannot win the race.
      reject(new AiTransientError(`Model call timed out after ${timeoutMs} ms.`));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      backend.generateAsync({ ...call, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ModelRunOutcome<T> {
  output: T;
  usage: TokenUsage;
  attempts: number;
  raw: unknown;
}

async function runModelAsync<T>(
  backend: ModelBackend,
  call: Omit<ModelCallRequest, "signal">,
  outputSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  settings: ClientSettings,
): Promise<ModelRunOutcome<T>> {
  let usage = emptyUsage();
  let attempts = 0;
  let retries = 0;
  let retriedInvalidOutput = false;

  for (;;) {
    attempts += 1;
    let result: ModelCallResult;

    try {
      result = await callWithTimeoutAsync(backend, call, settings.timeoutMs);
    } catch (error) {
      if (error instanceof AiError) {
        usage = addUsage(usage, error.usage);
      }

      const details = { cause: error, attempts, usage, cost: estimateCost(usage, call.tier) };
      const transient = isTransientAiError(error);
      const retryAfterMs = retryAfterMsOf(error);

      if (transient && retryAfterMs !== undefined && retryAfterMs > settings.maxRetryAfterMs) {
        throw new AiTransientError(
          `Model call failed after ${attempts} attempt(s); the provider asked to retry after ${retryAfterMs} ms, longer than the ${settings.maxRetryAfterMs} ms limit: ${messageOf(error)}`,
          { ...details, retryAfterMs },
        );
      }

      if (transient && retries < settings.maxRetries) {
        await settings.sleepAsync(backoffDelayMs(retries, settings, retryAfterMs));
        retries += 1;
        continue;
      }

      if (transient) {
        throw new AiTransientError(
          `Model call failed after ${attempts} attempt(s): ${messageOf(error)}`,
          details,
        );
      }

      throw new AiNonTransientError(messageOf(error), {
        ...details,
        reason: nonTransientReasonOf(error),
      });
    }

    usage = addUsage(usage, result.usage);
    const validation = validateOutput(result.text, outputSchema);

    if (validation.ok) {
      return { output: validation.value, usage, attempts, raw: result.raw };
    }

    if (!retriedInvalidOutput && retries < settings.maxRetries) {
      retriedInvalidOutput = true;
      retries += 1;
      continue;
    }

    throw new AiOutputValidationError(
      `Model output did not match the expected schema: ${validation.issues.join("; ")}`,
      validation.issues,
      result.text,
      { attempts, usage, cost: estimateCost(usage, call.tier) },
    );
  }
}

function resolveMaxOutputTokens(requested: number | undefined, fallback: number): number {
  return requested !== undefined && Number.isInteger(requested) && requested > 0
    ? requested
    : fallback;
}

export function createAiClient(backend: ModelBackend, options: AiClientOptions = {}): AiClient {
  const settings = resolveSettings(options);

  async function runStructuredAsync<
    TInputSchema extends z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny,
  >(
    request: RunStructuredRequest<TInputSchema, TOutputSchema>,
  ): Promise<RunStructuredResult<z.output<TOutputSchema>>> {
    const parsedInput = request.inputSchema.safeParse(request.input);

    if (!parsedInput.success) {
      const issues = formatIssues(parsedInput.error);

      throw new AiInputValidationError(
        `Model input did not match the input schema: ${issues.join("; ")}`,
        issues,
      );
    }

    const grounding = request.grounding === true;
    const model = modelForTier(request.tier);
    const prompt =
      typeof parsedInput.data === "string"
        ? parsedInput.data
        : JSON.stringify(parsedInput.data, null, 2);

    const outcome = await runModelAsync<z.output<TOutputSchema>>(
      backend,
      {
        key: request.key,
        tier: request.tier,
        model,
        system: request.system,
        prompt,
        outputSchema: request.outputSchema,
        grounding,
        maxOutputTokens: resolveMaxOutputTokens(
          request.maxOutputTokens,
          settings.defaultMaxOutputTokens,
        ),
        temperature: request.temperature,
      },
      request.outputSchema,
      settings,
    );

    const result: RunStructuredResult<z.output<TOutputSchema>> = {
      output: outcome.output,
      usage: outcome.usage,
      cost: estimateCost(outcome.usage, request.tier),
      tier: request.tier,
      model,
      attempts: outcome.attempts,
      needsVerification: false,
    };

    if (grounding) {
      result.citations = extractCitations(outcome.raw);
      result.needsVerification = result.citations.length === 0;
    }

    return result;
  }

  async function extractFromImageAsync(
    request: ImageExtractionRequest,
  ): Promise<ImageExtractionResult> {
    const tier = request.tier ?? "cheap";
    const mode = request.mode ?? "auto";
    const lineBoxes = request.lineBoxes ?? true;
    const issues: string[] = [];

    if (tier !== "cheap" && tier !== "mid") {
      issues.push(`tier: image extraction supports the cheap and mid tiers, got "${tier}"`);
    }

    if (request.image.length === 0) {
      issues.push("image: must not be empty");
    }

    if (!request.mimeType.trim()) {
      issues.push("mimeType: must not be empty");
    }

    if (issues.length > 0) {
      throw new AiInputValidationError(
        `Invalid image extraction request: ${issues.join("; ")}`,
        issues,
      );
    }

    const model = modelForTier(tier);
    const outcome = await runModelAsync(
      backend,
      {
        key: request.key ?? IMAGE_EXTRACTION_KEY,
        tier,
        model,
        system: imageExtractionSystemPrompt(mode, lineBoxes),
        prompt: "Transcribe this page.",
        media: toImageMedia(request),
        outputSchema: imageExtractionModelOutputSchema,
        grounding: false,
        maxOutputTokens: resolveMaxOutputTokens(
          request.maxOutputTokens,
          DEFAULT_IMAGE_MAX_OUTPUT_TOKENS,
        ),
        temperature: 0,
      },
      imageExtractionModelOutputSchema,
      settings,
    );

    const handwriting = mode === "handwriting" || outcome.output.handwriting;
    const confidence = handwriting
      ? Math.min(outcome.output.confidence, HANDWRITING_CONFIDENCE_CAP)
      : outcome.output.confidence;

    return {
      text: outcome.output.text,
      confidence,
      method: handwriting ? "handwriting" : "ocr",
      handwriting,
      lines: lineBoxes ? toTextSpans(outcome.output.lines) : [],
      usage: outcome.usage,
      cost: estimateCost(outcome.usage, tier),
      tier,
      model,
      attempts: outcome.attempts,
    };
  }

  return {
    provider: backend.provider,
    runStructuredAsync,
    extractFromImageAsync,
  };
}
