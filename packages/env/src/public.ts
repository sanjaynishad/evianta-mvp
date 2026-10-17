// Browser-safe settings. Next.js inlines NEXT_PUBLIC_ values at build time only where they are
// referenced literally, so this entry point keeps those references and reads nothing else.

export function normalizeApiBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, "");
}

export const webApiBaseUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_EVIANTA_API_URL);
