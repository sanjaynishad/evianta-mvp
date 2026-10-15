import { aiProvider, type AiProvider } from "@evianta/env";
import { googleAI, vertexAI } from "@genkit-ai/google-genai";
import { genkit } from "genkit";

export function createAi(provider: AiProvider = aiProvider) {
  if (provider === "vertexai") {
    return genkit({ plugins: [vertexAI()] });
  }

  return genkit({ plugins: [googleAI()] });
}

export const ai = createAi();
