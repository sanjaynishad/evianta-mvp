import { activeFindings } from "@evianta/agents";
import type {
  Case,
  Deliverable,
  DocumentMetadata,
  Evidence,
  ExtractedDocument,
  Finding,
  RunEvent,
  Task,
  TokenUsage,
} from "@evianta/core";
import { pagesNeedingReview } from "@evianta/ingest";
import { StoreNotFoundError, type Store } from "@evianta/store";

import type { DocumentErrorCode, IngestionService } from "./ingestion.js";
import { messageOf, silentApiLogger, type ApiLogger } from "./logger.js";
import type { RunLauncher } from "./runs.js";

export type DocumentStatus = "pending" | "processing" | "ready" | "partial" | "failed";

export interface ExtractionSummary {
  kind: ExtractedDocument["kind"];
  method: ExtractedDocument["method"];
  confidence: number;
  pageCount: number;
  tableCount: number;
  warnings: string[];
  /** Handwritten or low-confidence pages a reviewer should check. */
  pagesNeedingReview: number[];
  handwriting: boolean;
}

/** Document metadata without the storage path, plus its extraction state. */
export interface DocumentView extends Omit<DocumentMetadata, "gcsPath"> {
  status: DocumentStatus;
  error?: string;
  errorCode?: DocumentErrorCode;
  extraction?: ExtractionSummary;
}

export interface CaseCostView {
  tokenUsage: TokenUsage;
  costEstimate: number;
  runCount: number;
  lastRunAt?: string;
}

export interface CaseRunView {
  active: boolean;
  /** Seq of the newest persisted event; stream with `?after=` this value to see only new events. */
  lastEventSeq: number;
  lastRunId?: string;
  lastEventType?: RunEvent["type"];
  /** Absent when the last run failed before it started. */
  lastRunMode?: "run" | "retry";
  /** Present when the last run ended with run-failed. */
  lastRunError?: string;
}

export interface CaseStateView {
  case: Case;
  tasks: Task[];
  findings: Finding[];
  evidence: Evidence[];
  deliverables: Deliverable[];
  documents: DocumentView[];
  cost: CaseCostView;
  run: CaseRunView;
}

export function summarizeExtraction(extraction: ExtractedDocument): ExtractionSummary {
  return {
    kind: extraction.kind,
    method: extraction.method,
    confidence: extraction.confidence,
    pageCount: extraction.pages.length,
    tableCount: extraction.tables.length,
    warnings: extraction.warnings,
    pagesNeedingReview: pagesNeedingReview(extraction),
    handwriting: extraction.pages.some((page) => page.method === "handwriting"),
  };
}

export function toDocumentView(
  metadata: DocumentMetadata,
  extraction: ExtractedDocument | undefined,
  ingestion: IngestionService,
): DocumentView {
  const { id, caseId, name, mimeType, size, uploadedAt } = metadata;
  const rest = { id, caseId, name, mimeType, size, uploadedAt };
  const state = ingestion.stateOf(metadata.caseId, metadata.id);

  if (state?.status === "processing") {
    return { ...rest, status: "processing" };
  }

  if (extraction) {
    return { ...rest, status: "ready", extraction: summarizeExtraction(extraction) };
  }

  if (state) {
    return {
      ...rest,
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      ...(state.extraction ? { extraction: summarizeExtraction(state.extraction) } : {}),
    };
  }

  return { ...rest, status: "pending" };
}

export async function loadDocumentViewsAsync(
  store: Store,
  ingestion: IngestionService,
  caseId: string,
): Promise<DocumentView[]> {
  const documents = await store.documents.getDocumentsForCaseAsync(caseId);
  const extractions = await Promise.all(
    documents.map((document) => store.documents.getExtractionAsync(caseId, document.id)),
  );

  return documents.map((document, index) =>
    toDocumentView(document, extractions[index], ingestion),
  );
}

export function costOf(caseRecord: Case): CaseCostView {
  const input = caseRecord.usage?.inputTokens ?? 0;
  const output = caseRecord.usage?.outputTokens ?? 0;

  return {
    tokenUsage: { input, output, total: input + output },
    costEstimate: caseRecord.usage?.costEstimate ?? 0,
    runCount: caseRecord.usage?.runCount ?? 0,
    ...(caseRecord.usage?.lastRunAt ? { lastRunAt: caseRecord.usage.lastRunAt } : {}),
  };
}

/** Findings from each task's latest completed attempt, and only the evidence they cite. */
export async function loadActiveRecordAsync(
  store: Store,
  caseId: string,
): Promise<{ tasks: Task[]; findings: Finding[]; evidence: Evidence[] }> {
  const [tasks, storedFindings, storedEvidence] = await Promise.all([
    store.tasks.getTasksForCaseAsync(caseId),
    store.findings.getFindingsForCaseAsync(caseId),
    store.evidence.getEvidenceForCaseAsync(caseId),
  ]);
  const findings = activeFindings(storedFindings, tasks);
  const citedIds = new Set(findings.flatMap((finding) => finding.evidence.map((item) => item.id)));

  return {
    tasks,
    findings,
    evidence: storedEvidence.filter((item) => citedIds.has(item.id)),
  };
}

/**
 * Reads the run cursor before the rest of the state, so streaming after `run.lastEventSeq` never
 * misses a change that the returned state does not already include.
 */
export async function loadCaseStateAsync(
  store: Store,
  ingestion: IngestionService,
  runs: RunLauncher,
  caseId: string,
  logger: ApiLogger = silentApiLogger,
): Promise<CaseStateView | undefined> {
  const events = await store.events.listEventsAsync(caseId);
  const lastEvent = events.at(-1);
  const lastRunStart = lastEvent
    ? events.find((event) => event.type === "run-started" && event.runId === lastEvent.runId)
    : undefined;

  // Applies charges journaled before the cursor's cost events, so the totals are not older than
  // them; each charge is applied once, alongside the run's own reconciliation.
  try {
    await store.runs.reconcileUsageAsync(caseId);
  } catch (error) {
    if (!(error instanceof StoreNotFoundError)) {
      logger.warn("Could not reconcile case usage.", { caseId, error: messageOf(error) });
    }
  }

  const [caseRecord, record, deliverables, documents] = await Promise.all([
    store.cases.getCaseAsync(caseId),
    loadActiveRecordAsync(store, caseId),
    store.deliverables.getDeliverablesForCaseAsync(caseId),
    loadDocumentViewsAsync(store, ingestion, caseId),
  ]);
  // Sampled after the reads: a cursor that includes the terminal event never pairs with active.
  const active = runs.isActive(caseId);

  if (!caseRecord) {
    return undefined;
  }

  return {
    case: caseRecord,
    tasks: record.tasks,
    findings: record.findings,
    evidence: record.evidence,
    deliverables,
    documents,
    cost: costOf(caseRecord),
    run: {
      active,
      lastEventSeq: lastEvent?.seq ?? 0,
      ...(lastEvent ? { lastRunId: lastEvent.runId, lastEventType: lastEvent.type } : {}),
      ...(lastRunStart?.type === "run-started" ? { lastRunMode: lastRunStart.mode } : {}),
      ...(lastEvent?.type === "run-failed" ? { lastRunError: lastEvent.error } : {}),
    },
  };
}
