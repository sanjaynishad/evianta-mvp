import { aiProvider, type AiProvider } from "@evianta/env";
import type { z } from "zod";

import { createAiClient, type AiClientOptions } from "./client.js";
import { createGenkitBackend } from "./genkit.js";
import { createMockAi, type MockScript } from "./mock.js";
import type {
  AiClient,
  ImageExtractionRequest,
  ImageExtractionResult,
  RunStructuredRequest,
  RunStructuredResult,
} from "./types.js";

export * from "./client.js";
export * from "./errors.js";
export * from "./grounding.js";
export * from "./image.js";
export * from "./mock.js";
export * from "./models.js";
export * from "./pricing.js";
export * from "./types.js";
export { createGenkitBackend, type GenkitProvider, type GenkitRuntime } from "./genkit.js";
export type { AiProvider } from "@evianta/env";

export interface CreateAiOptions extends AiClientOptions {
  /** Scripted outputs, used only by the mock provider. */
  mockScript?: MockScript;
}

export function createAi(
  provider: AiProvider = aiProvider,
  options: CreateAiOptions = {},
): AiClient {
  const { mockScript, ...clientOptions } = options;

  if (provider === "mock") {
    return createMockAi(mockScript, clientOptions);
  }

  return createAiClient(createGenkitBackend(provider), clientOptions);
}

let sharedClient: AiClient | undefined;

/** Returns the process-wide client for EVIANTA_AI_PROVIDER, created on first use. */
export function getAi(): AiClient {
  sharedClient ??= createAi();

  return sharedClient;
}

/** Overrides the shared client, for example with a mock in tests. Pass undefined to reset. */
export function setAi(client: AiClient | undefined): void {
  sharedClient = client;
}

export function runStructuredAsync<
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
>(
  request: RunStructuredRequest<TInputSchema, TOutputSchema>,
): Promise<RunStructuredResult<z.output<TOutputSchema>>> {
  return getAi().runStructuredAsync(request);
}

export function extractFromImageAsync(
  request: ImageExtractionRequest,
): Promise<ImageExtractionResult> {
  return getAi().extractFromImageAsync(request);
}
