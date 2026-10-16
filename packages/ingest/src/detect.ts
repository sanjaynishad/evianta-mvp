import type { DocumentMetadata } from "@evianta/core";

import { UnsupportedDocumentTypeError } from "./errors.js";

export type DocumentFormat = "csv" | "tsv" | "xlsx" | "xls" | "pdf" | "image";

export interface DetectedFormat {
  format: DocumentFormat;
  /** Canonical MIME type for the detected format. */
  mimeType: string;
}

export const SUPPORTED_MIME_TYPES = [
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";

const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/x-csv",
  "text/comma-separated-values",
]);
const TSV_MIME_TYPES = new Set(["text/tab-separated-values", "text/tsv"]);
const XLSX_MIME_TYPES = new Set([XLSX_MIME, "application/vnd.ms-excel.sheet.macroenabled.12"]);

function startsWithBytes(buffer: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function asciiAt(buffer: Uint8Array, offset: number, length: number): string {
  return Buffer.from(buffer.subarray(offset, offset + length)).toString("latin1");
}

function sniffMagic(buffer: Uint8Array): string | undefined {
  if (Buffer.from(buffer.subarray(0, 1024)).includes("%PDF-")) {
    return "application/pdf";
  }

  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  const header = asciiAt(buffer, 0, 6);

  if (header === "GIF87a" || header === "GIF89a") {
    return "image/gif";
  }

  if (asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP") {
    return "image/webp";
  }

  if (
    startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "image/tiff";
  }

  if (startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }

  if (startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "application/x-ole-storage";
  }

  return undefined;
}

function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());

  return match?.[1]?.toLowerCase() ?? "";
}

function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function looksLikeBinary(buffer: Uint8Array): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

/** Detects the format from magic bytes first, then the declared MIME type, then the extension. */
export function detectDocumentFormat(
  buffer: Uint8Array,
  metadata: Pick<DocumentMetadata, "mimeType" | "name">,
): DetectedFormat {
  const declared = normalizeMime(metadata.mimeType);
  const extension = extensionOf(metadata.name);
  const sniffed = sniffMagic(buffer);
  const unsupported = new UnsupportedDocumentTypeError(metadata.mimeType, metadata.name);

  if (sniffed === "application/pdf") {
    return { format: "pdf", mimeType: sniffed };
  }

  if (sniffed?.startsWith("image/")) {
    if (sniffed === "image/tiff" || sniffed === "image/gif") {
      throw new UnsupportedDocumentTypeError(
        sniffed,
        metadata.name,
        "Convert TIFF or GIF to PNG, JPEG, WEBP, or a PDF preserving all pages before uploading.",
      );
    }

    return { format: "image", mimeType: sniffed };
  }

  if (sniffed === "application/zip") {
    const declaresXlsx =
      XLSX_MIME_TYPES.has(declared) || extension === "xlsx" || extension === "xlsm";

    if (declaresXlsx || Buffer.from(buffer).includes("xl/workbook")) {
      return { format: "xlsx", mimeType: XLSX_MIME };
    }

    throw unsupported;
  }

  if (sniffed === "application/x-ole-storage") {
    if (declared === XLS_MIME || extension === "xls") {
      return { format: "xls", mimeType: XLS_MIME };
    }

    throw unsupported;
  }

  if (looksLikeBinary(buffer)) {
    throw unsupported;
  }

  if (TSV_MIME_TYPES.has(declared) || extension === "tsv" || extension === "tab") {
    return { format: "tsv", mimeType: "text/tab-separated-values" };
  }

  // Browsers on Windows often report .csv uploads as application/vnd.ms-excel.
  if (CSV_MIME_TYPES.has(declared) || extension === "csv") {
    return { format: "csv", mimeType: "text/csv" };
  }

  if (declared.startsWith("image/") || declared === "application/pdf") {
    throw new UnsupportedDocumentTypeError(
      metadata.mimeType,
      metadata.name,
      "The file content does not match the declared type.",
    );
  }

  throw unsupported;
}
