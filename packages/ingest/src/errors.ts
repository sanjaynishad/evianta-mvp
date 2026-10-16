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
        "Supported inputs are CSV, TSV, XLSX, XLS, PDF, PNG, JPEG, and WEBP.",
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

export class OcrExtractionError extends DocumentExtractionError {
  readonly usage: TokenUsage;
  readonly cost: Cost;
  readonly pageUsage: PageOcrUsage[];
  readonly errors: unknown[];

  constructor(
    documentId: string,
    accounting: { usage: TokenUsage; cost: Cost; pageUsage: PageOcrUsage[] },
    errors: unknown[],
  ) {
    const first = errors[0];

    super(
      documentId,
      `All OCR pages failed: ${first instanceof Error ? first.message : String(first)}`,
      { cause: new AggregateError(errors, "All OCR pages failed.") },
    );
    this.name = "OcrExtractionError";
    this.usage = accounting.usage;
    this.cost = accounting.cost;
    this.pageUsage = accounting.pageUsage;
    this.errors = errors;
  }
}
