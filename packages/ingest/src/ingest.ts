import type { DocumentMetadata } from "@evianta/core";
import { emptyUsage, getAi, type AiClient } from "@evianta/ai";
import type { DocumentStore, Store } from "@evianta/store";

import { DocumentExtractionError } from "./errors.js";
import {
  createGeminiExtractor,
  type ExtractionOptions,
  type ExtractionOutcome,
  type Extractor,
} from "./extract.js";

export interface IngestOptions extends ExtractionOptions {
  /** Re-extract even when a cached extraction exists. */
  force?: boolean;
}

export interface IngestDocumentRequest {
  caseId: string;
  document: DocumentMetadata;
  store: Pick<Store, "documents">;
  documentStore: Pick<DocumentStore, "readBufferAsync">;
  /** Used by the default extractor; defaults to the shared client from getAi(). */
  ai?: Pick<AiClient, "extractFromImageAsync">;
  /** Overrides the default Gemini-backed extractor. */
  extractor?: Extractor;
  options?: IngestOptions;
}

export interface IngestResult extends ExtractionOutcome {
  /** True when the stored extraction was reused and no extraction ran. */
  cached: boolean;
}

/**
 * Returns the cached extraction for the document, or extracts it and caches the result.
 * Extractions with failed OCR pages are returned but not cached, so a later run retries them.
 */
export async function ingestDocumentAsync(request: IngestDocumentRequest): Promise<IngestResult> {
  const { caseId, document, store, documentStore, options = {} } = request;
  const { force = false, ...extractionOptions } = options;

  if (document.caseId !== caseId) {
    throw new DocumentExtractionError(
      document.id,
      `Document "${document.id}" belongs to case "${document.caseId}", not "${caseId}".`,
    );
  }

  if (!force) {
    const cached = await store.documents.getExtractionAsync(caseId, document.id);

    if (cached) {
      return {
        extraction: cached,
        usage: emptyUsage(),
        cost: 0,
        pageUsage: [],
        failedPages: [],
        cached: true,
      };
    }
  }

  const extractor = request.extractor ?? createGeminiExtractor({ ai: request.ai ?? getAi() });
  const buffer = await documentStore.readBufferAsync(document.gcsPath);
  const outcome = await extractor.extractAsync(buffer, document, extractionOptions);

  if (outcome.extraction.documentId !== document.id) {
    throw new DocumentExtractionError(
      document.id,
      `Extractor "${extractor.name}" returned an extraction for "${outcome.extraction.documentId}".`,
    );
  }

  const extraction =
    outcome.failedPages.length === 0
      ? await store.documents.saveExtractionAsync(caseId, outcome.extraction)
      : outcome.extraction;

  return { ...outcome, extraction, cached: false };
}
