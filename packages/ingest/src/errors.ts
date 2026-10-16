export class UnsupportedDocumentTypeError extends Error {
  readonly mimeType: string;
  readonly fileName: string;

  constructor(mimeType: string, fileName: string, reason?: string) {
    super(
      [
        `Unsupported document type "${mimeType || "unknown"}" for "${fileName}".`,
        reason,
        "Supported inputs are CSV, TSV, XLSX, XLS, PDF, PNG, JPEG, WEBP, TIFF, and GIF.",
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
