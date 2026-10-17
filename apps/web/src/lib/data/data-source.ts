import { createApiClient } from "@/lib/api/client";
import { apiBaseUrl } from "@/lib/env";
import { getVisitorId } from "@/lib/visitor";
import { createFixtureDataSource } from "./fixture-data-source";
import type { CaseDataSource } from "./types";

let browserDataSource: CaseDataSource | undefined;

export function createDataSource(): CaseDataSource {
  if (apiBaseUrl) {
    return createApiClient({ baseUrl: apiBaseUrl, getVisitorId: () => getVisitorId() });
  }

  return createFixtureDataSource();
}

// One instance per browser tab so fixture mode keeps its in-memory cases across navigations.
export function getDataSource(): CaseDataSource {
  browserDataSource ??= createDataSource();
  return browserDataSource;
}

// Server-side reads (the usage view) are not scoped to a visitor.
export function createServerDataSource(): CaseDataSource {
  if (apiBaseUrl) {
    return createApiClient({ baseUrl: apiBaseUrl });
  }

  return createFixtureDataSource({ replayIntervalMs: 0 });
}
