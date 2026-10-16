export type DataSourceMode = "live" | "fixtures";

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, "");
}

// Next.js inlines NEXT_PUBLIC_ values at build time only when they are referenced literally.
export const apiBaseUrl = normalizeBaseUrl(process.env.NEXT_PUBLIC_EVIANTA_API_URL);

export const dataSourceMode: DataSourceMode = apiBaseUrl ? "live" : "fixtures";
