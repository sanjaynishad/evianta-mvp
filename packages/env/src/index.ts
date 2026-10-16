export const aiProviders = ["googleai", "vertexai", "mock"] as const;

export type AiProvider = (typeof aiProviders)[number];

export function parseAiProvider(value: string | undefined): AiProvider {
  const normalized = value?.trim().toLowerCase();

  return aiProviders.find((provider) => provider === normalized) ?? "googleai";
}

export const aiProvider: AiProvider = parseAiProvider(process.env.EVIANTA_AI_PROVIDER);

export const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";

export const googleCloudProject = process.env.GOOGLE_CLOUD_PROJECT ?? "";

export const googleCloudLocation = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

export const port = Number(process.env.PORT ?? 8080);

export const gcsBucket = process.env.GCS_BUCKET?.trim() ?? "";

export const usageViewPath = (process.env.EVIANTA_USAGE_VIEW_PATH ?? "")
  .trim()
  .replace(/^\/+|\/+$/g, "");

export const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim() ?? "";

export const storageEmulatorHost = process.env.STORAGE_EMULATOR_HOST?.trim() ?? "";
