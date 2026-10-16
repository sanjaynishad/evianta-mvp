export function normalizeUsageViewPath(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "");
}

// Read per request so a container image can be configured at deploy time.
export function getUsageViewPath(): string {
  return normalizeUsageViewPath(process.env.EVIANTA_USAGE_VIEW_PATH);
}
