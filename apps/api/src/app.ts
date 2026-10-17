import { randomUUID } from "node:crypto";

import type { Orchestrator, RunEventBus } from "@evianta/agents";
import type { AiClient } from "@evianta/ai";
import { ingestDocumentAsync } from "@evianta/ingest";
import type { DocumentStore, Store } from "@evianta/store";
import express, { type Express } from "express";

import { createCaseActivityTracker, type ApiConfig, type ApiContext } from "./context.js";
import { createCorsMiddleware } from "./cors.js";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { createIngestionService, type IngestFunction } from "./ingestion.js";
import { jsonLogger, type ApiLogger } from "./logger.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createCaseRoutes } from "./routes/cases.js";
import { createDeliverableRoutes } from "./routes/deliverables.js";
import { createReviewRoutes } from "./routes/review.js";
import { createRunRoutes } from "./routes/runs.js";
import { createRunLauncher } from "./runs.js";
import { createUsageViewRouter } from "./usageView.js";

export const DEFAULT_API_CONFIG: ApiConfig = {
  webOrigins: [],
  usageViewPath: "",
  sseHeartbeatMs: 15_000,
  maxUploadBytes: 25 * 1024 * 1024,
  maxFilesPerUpload: 10,
};

export interface AppDependencies {
  store: Store;
  documentStore: DocumentStore;
  ai: AiClient;
  orchestrator: Orchestrator;
  /** The bus the orchestrator publishes to; defaults to `orchestrator.events`. */
  events?: RunEventBus;
  /** Document extraction; defaults to `ingestDocumentAsync` from @evianta/ingest. */
  ingest?: IngestFunction;
  config?: Partial<ApiConfig>;
  logger?: ApiLogger;
  newId?: () => string;
  now?: () => Date;
}

export interface EviantaApp extends Express {
  /** Resolves once background ingestion and runs have finished (for tests and shutdown). */
  idleAsync(): Promise<void>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createApp(dependencies: AppDependencies): EviantaApp {
  const overrides = Object.fromEntries(
    Object.entries(dependencies.config ?? {}).filter(([, value]) => value !== undefined),
  );
  const config: ApiConfig = { ...DEFAULT_API_CONFIG, ...overrides };
  const logger = dependencies.logger ?? jsonLogger;
  const newId = dependencies.newId ?? randomUUID;
  const events = dependencies.events ?? dependencies.orchestrator.events;
  const ingestion = createIngestionService({
    store: dependencies.store,
    documentStore: dependencies.documentStore,
    ai: dependencies.ai,
    ingest: dependencies.ingest ?? ingestDocumentAsync,
    logger,
  });
  const runs = createRunLauncher({
    store: dependencies.store,
    orchestrator: dependencies.orchestrator,
    events,
    ingestion,
    logger,
    newId,
  });
  const ctx: ApiContext = {
    store: dependencies.store,
    documentStore: dependencies.documentStore,
    ai: dependencies.ai,
    orchestrator: dependencies.orchestrator,
    events,
    ingestion,
    runs,
    uploads: createCaseActivityTracker(),
    approvals: createCaseActivityTracker(),
    logger,
    config,
    newId,
    now: dependencies.now ?? (() => new Date()),
  };
  const app = express();

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(createCorsMiddleware(config.webOrigins));
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "evianta-api" });
  });

  const usageViewPath = config.usageViewPath.replace(/^\/+|\/+$/g, "");

  if (usageViewPath) {
    app.use(
      new RegExp(`^/${escapeRegExp(usageViewPath)}(?=/|$)`),
      createUsageViewRouter(dependencies.store),
    );
  }

  app.use(createAgentRoutes(ctx));
  app.use(createCaseRoutes(ctx));
  app.use(createRunRoutes(ctx));
  app.use(createDeliverableRoutes(ctx));
  app.use(createReviewRoutes(ctx));
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return Object.assign(app, {
    async idleAsync() {
      await runs.idleAsync();
      await ingestion.idleAsync();
    },
  });
}
