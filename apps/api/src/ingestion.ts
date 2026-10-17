import type { AiClient, Cost } from "@evianta/ai";
import type { DocumentMetadata, ExtractedDocument, TokenUsage } from "@evianta/core";
import {
  DocumentExtractionError,
  OcrConfigurationError,
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
  /** Client-safe text; provider and parser diagnostics are only logged. */
  error?: string;
  errorCode?: DocumentErrorCode;
  /** False when the file itself cannot be read, so extracting it again would not help. */
  retryable?: boolean;
  /** The uncached result of a partial extraction, kept so the UI can show what was read. */
  extraction?: ExtractedDocument;
}

export interface IngestionService {
  /** Starts extraction off the request thread; failures are recorded, never thrown. */
  enqueue(document: DocumentMetadata): void;
  /**
   * Waits for in-flight work, then extracts every document of the case that has no cached
   * extraction. Throws DocumentsUnavailableError when a document is still unread for a reason a
   * later attempt may fix, so a run does not proceed without it.
   */
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

export interface UnavailableDocument {
  id: string;
  name: string;
  error?: string;
}

export class DocumentsUnavailableError extends Error {
  constructor(readonly documents: UnavailableDocument[]) {
    super(
      `Could not read ${documents.map((document) => `"${document.name}"`).join(", ")} yet, so ` +
        "the run did not start. Start the run again to retry.",
    );
    this.name = "DocumentsUnavailableError";
  }
}

function isPermanentIngestError(error: unknown): boolean {
  return (
    error instanceof UnsupportedDocumentTypeError ||
    (error instanceof DocumentExtractionError && !(error instanceof OcrExtractionError))
  );
}

export type DocumentErrorCode =
  | "unsupported-type"
  | "ocr-unavailable"
  | "ocr-failed"
  | "ocr-partial"
  | "extraction-failed"
  | "read-failed";

interface DescribedIngestError {
  code: DocumentErrorCode;
  message: string;
}

// Only messages composed from the file's own name and type reach clients; OCR and parser errors
// can carry provider or library diagnostics, so they are logged and replaced with fixed text.
function describeIngestError(error: unknown): DescribedIngestError {
  if (error instanceof UnsupportedDocumentTypeError) {
    return { code: "unsupported-type", message: error.message };
  }

  if (error instanceof OcrConfigurationError) {
    return {
      code: "ocr-unavailable",
      message: "Text recognition is not available right now. It is retried when the case runs.",
    };
  }

  if (error instanceof OcrExtractionError) {
    return {
      code: "ocr-failed",
      message: "Text recognition failed for this document. It is retried when the case runs.",
    };
  }

  if (error instanceof DocumentExtractionError) {
    return {
      code: "extraction-failed",
      message: "The document could not be read. Check that the file opens, then upload it again.",
    };
  }

  return {
    code: "read-failed",
    message: "The document could not be read. It is retried when the case runs.",
  };
}

const FAILED_PAGE_WARNING = /^Page \d+: extraction failed\b/;

// Failed-page warnings from OCR embed the provider error, so they are replaced with fixed text.
export function withClientSafeWarnings(
  extraction: ExtractedDocument,
  failedPages: readonly number[],
): ExtractedDocument {
  return {
    ...extraction,
    warnings: [
      ...extraction.warnings.filter((warning) => !FAILED_PAGE_WARNING.test(warning)),
      ...failedPages.map(
        (page) => `Page ${page}: text recognition failed; the page content is missing.`,
      ),
    ],
  };
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
            errorCode: "ocr-partial",
            retryable: true,
            extraction: withClientSafeWarnings(result.extraction, result.failedPages),
          });
          logger.warn("Document extraction was partial.", {
            caseId: document.caseId,
            documentId: document.id,
            failedPages: result.failedPages,
            warnings: result.extraction.warnings,
          });
        } else {
          states.delete(key);
        }
      } catch (error) {
        if (error instanceof OcrExtractionError) {
          await recordUsageAsync(document.caseId, error.usage, error.cost);
        }

        const described = describeIngestError(error);

        states.set(key, {
          status: "failed",
          error: described.message,
          errorCode: described.code,
          retryable: !isPermanentIngestError(error),
        });
        logger.warn("Document extraction failed.", {
          caseId: document.caseId,
          documentId: document.id,
          code: described.code,
          error: messageOf(error),
          cause: error instanceof Error && error.cause ? messageOf(error.cause) : undefined,
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
      const unavailable: UnavailableDocument[] = [];

      for (const document of documents) {
        await inFlight.get(keyOf(caseId, document.id));
        await ingestAsync(document);

        const state = states.get(keyOf(caseId, document.id));

        if (state?.retryable) {
          unavailable.push({
            id: document.id,
            name: document.name,
            ...(state.error ? { error: state.error } : {}),
          });
        }
      }

      if (unavailable.length > 0) {
        throw new DocumentsUnavailableError(unavailable);
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
