import type { TokenUsage } from "@evianta/core";
import type { Cost } from "@evianta/ai";

import type { PageOcrUsage } from "./extract.js";

export class UnsupportedDocumentTypeError extends Error {
  readonly mimeType: string;
  readonly fileName: string;

  constructor(mimeType: string, fileName: string, reason?: string) {
    super(
      [
        `Unsupported document type "${mimeType || "unknown"}" for "${fileName}".`,
        reason,
        "Supported inputs are CSV, TSV, XLSX, XLS, JSON, JSON Lines, TXT, Markdown, PDF, PNG, JPEG, and WEBP.",
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "UnsupportedDocumentTypeError";
    this.mimeType = mimeType;
    this.fileName = fileName;
  }
}

export class DocumentExtractionError extends Error {
  readonly documentId: string;

  constructor(documentId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentExtractionError";
    this.documentId = documentId;
  }
}

export interface OcrAccounting {
  usage: TokenUsage;
  cost: Cost;
  pageUsage: PageOcrUsage[];
}

export class OcrExtractionError extends DocumentExtractionError {
  readonly usage: TokenUsage;
  readonly cost: Cost;
  readonly pageUsage: PageOcrUsage[];
  readonly errors: unknown[];

  constructor(
    documentId: string,
    accounting: OcrAccounting,
    errors: unknown[],
    options: { message?: string; cause?: unknown } = {},
  ) {
    const first = errors[0];

    super(
      documentId,
      options.message ??
        `All OCR pages failed: ${first instanceof Error ? first.message : String(first)}`,
      { cause: options.cause ?? new AggregateError(errors, "All OCR pages failed.") },
    );
    this.name = "OcrExtractionError";
    this.usage = accounting.usage;
    this.cost = accounting.cost;
    this.pageUsage = accounting.pageUsage;
    this.errors = errors;
  }
}

/** OCR stopped because the model is not configured or access was denied; `cause` is the original error. */
export class OcrConfigurationError extends OcrExtractionError {
  constructor(documentId: string, accounting: OcrAccounting, errors: unknown[]) {
    const first = errors[0];

    super(documentId, accounting, errors, {
      message: `OCR is unavailable: ${first instanceof Error ? first.message : String(first)}`,
      cause: first,
    });
    this.name = "OcrConfigurationError";
  }
}
