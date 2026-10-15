export type AiProvider = "googleai" | "vertexai";

export const aiProvider: AiProvider =
  process.env.EVIANTA_AI_PROVIDER === "vertexai" ? "vertexai" : "googleai";

export const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";

export const googleCloudProject = process.env.GOOGLE_CLOUD_PROJECT ?? "";

export const googleCloudLocation = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

export const port = Number(process.env.PORT ?? 8080);
