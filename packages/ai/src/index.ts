import { googleAI, vertexAI } from "@genkit-ai/google-genai";
import { genkit } from "genkit";

export type AiProvider = "googleai" | "vertexai";

export function resolveProvider(): AiProvider {
  return process.env.EVIANTA_AI_PROVIDER === "vertexai" ? "vertexai" : "googleai";
}

export function createAi(provider: AiProvider = resolveProvider()) {
  if (provider === "vertexai") {
    return genkit({ plugins: [vertexAI()] });
  }

  return genkit({ plugins: [googleAI()] });
}

export const ai = createAi();
