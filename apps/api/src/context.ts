import type { Orchestrator, RunEventBus } from "@evianta/agents";
import type { AiClient } from "@evianta/ai";
import type { Case } from "@evianta/core";
import type { DocumentStore, Store } from "@evianta/store";

import { notFoundError, sampleReadOnlyError } from "./errors.js";
import type { IngestionService } from "./ingestion.js";
import type { ApiLogger } from "./logger.js";
import type { RunLauncher } from "./runs.js";

export interface ApiConfig {
  /** Origins allowed by CORS; requests from other origins get no CORS headers. */
  webOrigins: readonly string[];
  /** Mounts the unlisted usage view under this path when non-empty. */
  usageViewPath: string;
  sseHeartbeatMs: number;
  maxUploadBytes: number;
  maxFilesPerUpload: number;
}

export interface ApiContext {
  store: Store;
  documentStore: DocumentStore;
  ai: AiClient;
  orchestrator: Orchestrator;
  events: RunEventBus;
  ingestion: IngestionService;
  runs: RunLauncher;
  logger: ApiLogger;
  config: ApiConfig;
  newId: () => string;
  now: () => Date;
}

export async function getCaseOrThrowAsync(ctx: ApiContext, caseId: string): Promise<Case> {
  const caseRecord = await ctx.store.cases.getCaseAsync(caseId);

  if (!caseRecord) {
    throw notFoundError("case");
  }

  return caseRecord;
}

/** Loads a case that the request may change; sample cases are read-only. */
export async function getMutableCaseAsync(ctx: ApiContext, caseId: string): Promise<Case> {
  const caseRecord = await getCaseOrThrowAsync(ctx, caseId);

  if (caseRecord.isSample) {
    throw sampleReadOnlyError(caseId);
  }

  return caseRecord;
}
