import type { AiProvider } from "@evianta/env";
import type {
  Citation,
  ModelTier,
  PageExtractionMethod,
  TextSpan,
  TokenUsage,
} from "@evianta/core";
import type { z } from "zod";

import type { ModelId, VisionModelTier } from "./models.js";
import type { Cost } from "./pricing.js";

export interface RunStructuredRequest<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
> {
  tier: ModelTier;
  /** Agent role or prompt key. Used for tracing and to select scripted mock outputs. */
  key?: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  system: string;
  input: z.input<TInputSchema>;
  /** Opt-in Google Search grounding. Only research agents should enable it. */
  grounding?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface RunStructuredResult<TOutput> {
  output: TOutput;
  /** Summed across every attempt, including failed ones. */
  usage: TokenUsage;
  cost: Cost;
  tier: ModelTier;
  model: ModelId;
  attempts: number;
  /** Present only when grounding was requested. */
  citations?: Citation[];
  /** True when grounding was requested but returned no citations. */
  needsVerification: boolean;
}

export type ImageExtractionMode = "printed" | "handwriting" | "auto";

export interface ImageExtractionRequest {
  /** Raw bytes, base64 data, or a data URL. */
  image: Uint8Array | string;
  mimeType: string;
  mode?: ImageExtractionMode;
  tier?: VisionModelTier;
  key?: string;
  /** Ask the model for approximate line boxes. Defaults to true. */
  lineBoxes?: boolean;
  maxOutputTokens?: number;
}

export interface ImageExtractionResult {
  text: string;
  /** 0..1. Handwriting is capped at HANDWRITING_CONFIDENCE_CAP. */
  confidence: number;
  method: Extract<PageExtractionMethod, "ocr" | "handwriting">;
  handwriting: boolean;
  /** Line boxes normalized to 0..1, approximate. */
  lines: TextSpan[];
  usage: TokenUsage;
  cost: Cost;
  tier: VisionModelTier;
  model: ModelId;
  attempts: number;
}

export interface AiClient {
  readonly provider: AiProvider;
  runStructuredAsync<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny>(
    request: RunStructuredRequest<TInputSchema, TOutputSchema>,
  ): Promise<RunStructuredResult<z.output<TOutputSchema>>>;
  extractFromImageAsync(request: ImageExtractionRequest): Promise<ImageExtractionResult>;
}

export interface ModelMedia {
  /** A data URL or a fetchable URL. */
  url: string;
  contentType: string;
}

export interface ModelCallRequest {
  key?: string;
  tier: ModelTier;
  model: ModelId;
  system: string;
  prompt: string;
  media?: ModelMedia;
  outputSchema: z.ZodTypeAny;
  grounding: boolean;
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface ModelCallResult {
  text: string;
  usage: TokenUsage;
  /** Provider response, used for grounding metadata. */
  raw?: unknown;
}

export interface ModelBackend {
  readonly provider: AiProvider;
  generateAsync(request: ModelCallRequest): Promise<ModelCallResult>;
}
