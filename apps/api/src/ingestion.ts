import type { AiClient, Cost } from "@evianta/ai";
import type { DocumentMetadata, ExtractedDocument, TokenUsage } from "@evianta/core";
import {
  DocumentExtractionError,
  OcrExtractionError,
  UnsupportedDocumentTypeError,
  type IngestDocumentRequest,
  type IngestResult,
} from "@evianta/ingest";
import type { DocumentStore, Store } from "@evianta/store";

import { messageOf, type ApiLogger } from "./logger.js";

export type IngestFunction = (request: IngestDocumentRequest) => Promise<IngestResult>;

/** In-process ingestion state; a stored extraction means the document is ready. */
export interface DocumentIngestionState {
  status: "processing" | "partial" | "failed";
  error?: string;
  /** The uncached result of a partial extraction, kept so the UI can show what was read. */
  extraction?: ExtractedDocument;
}

export interface IngestionService {
  /** Starts extraction off the request thread; failures are recorded, never thrown. */
  enqueue(document: DocumentMetadata): void;
  /** Waits for in-flight work, then extracts every document of the case that has no cached extraction. */
  ensureCaseExtractedAsync(caseId: string): Promise<void>;
  stateOf(caseId: string, documentId: string): DocumentIngestionState | undefined;
  idleAsync(): Promise<void>;
}

export interface IngestionServiceOptions {
  store: Store;
  documentStore: DocumentStore;
  ai: AiClient;
  ingest: IngestFunction;
  logger: ApiLogger;
}

function keyOf(caseId: string, documentId: string): string {
  return `${caseId}\u0000${documentId}`;
}

function describeIngestError(error: unknown): string {
  if (error instanceof UnsupportedDocumentTypeError || error instanceof DocumentExtractionError) {
    return error.message;
  }

  return "The document could not be read. It will be retried when the case runs.";
}

export function createIngestionService(options: IngestionServiceOptions): IngestionService {
  const { store, documentStore, ai, ingest, logger } = options;
  const inFlight = new Map<string, Promise<void>>();
  const states = new Map<string, DocumentIngestionState>();

  async function recordUsageAsync(caseId: string, usage: TokenUsage, cost: Cost): Promise<void> {
    if (usage.total <= 0 && cost <= 0) {
      return;
    }

    try {
      await store.cases.updateCaseUsageAsync(caseId, {
        inputTokens: usage.input,
        outputTokens: usage.output,
        costEstimate: cost,
      });
    } catch (error) {
      logger.warn("Could not record document extraction usage.", {
        caseId,
        error: messageOf(error),
      });
    }
  }

  function ingestAsync(document: DocumentMetadata): Promise<void> {
    const key = keyOf(document.caseId, document.id);
    const existing = inFlight.get(key);

    if (existing) {
      return existing;
    }

    states.set(key, { status: "processing" });

    const work = (async () => {
      try {
        const result = await ingest({
          caseId: document.caseId,
          document,
          store,
          documentStore,
          ai,
        });

        if (!result.cached) {
          await recordUsageAsync(document.caseId, result.usage, result.cost);
        }

        if (result.failedPages.length > 0) {
          states.set(key, {
            status: "partial",
            error: `OCR failed on page(s) ${result.failedPages.join(", ")}. They are retried when the case runs.`,
            extraction: result.extraction,
          });
        } else {
          states.delete(key);
        }
      } catch (error) {
        if (error instanceof OcrExtractionError) {
          await recordUsageAsync(document.caseId, error.usage, error.cost);
        }

        states.set(key, { status: "failed", error: describeIngestError(error) });
        logger.warn("Document extraction failed.", {
          caseId: document.caseId,
          documentId: document.id,
          error: messageOf(error),
        });
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, work);

    return work;
  }

  return {
    enqueue(document) {
      void ingestAsync(document);
    },
    async ensureCaseExtractedAsync(caseId) {
      const documents = await store.documents.getDocumentsForCaseAsync(caseId);

      for (const document of documents) {
        await inFlight.get(keyOf(caseId, document.id));
        await ingestAsync(document);
      }
    },
    stateOf(caseId, documentId) {
      return states.get(keyOf(caseId, documentId));
    },
    async idleAsync() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
      }
    },
  };
}
