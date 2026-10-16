import { z } from "zod";

import { boundingBoxSchema } from "./evidence.js";

export const documentMetadataSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  gcsPath: z.string().min(1),
  uploadedAt: z.string(),
});

export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

export type DocumentMetadataInput = z.input<typeof documentMetadataSchema>;

export const extractedDocumentKindSchema = z.enum(["tabular", "text"]);

export type ExtractedDocumentKind = z.infer<typeof extractedDocumentKindSchema>;

export const pageExtractionMethodSchema = z.enum(["parse", "pdf-text", "ocr", "handwriting"]);

export type PageExtractionMethod = z.infer<typeof pageExtractionMethodSchema>;

export const extractionMethodSchema = z.enum([...pageExtractionMethodSchema.options, "mixed"]);

export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;

const extractionConfidenceSchema = z.number().min(0).max(1);

export const textSpanSchema = z.object({
  text: z.string(),
  bbox: boundingBoxSchema,
  confidence: extractionConfidenceSchema.optional(),
});

export type TextSpan = z.infer<typeof textSpanSchema>;

export const extractedPageSchema = z.object({
  // 1-based, matching evidenceLocationSchema.page.
  index: z.number().int().positive(),
  text: z.string(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  method: pageExtractionMethodSchema,
  confidence: extractionConfidenceSchema,
  spans: z.array(textSpanSchema).optional(),
});

export type ExtractedPage = z.infer<typeof extractedPageSchema>;

export const tableColumnTypeSchema = z.enum(["string", "number", "boolean", "date", "empty"]);

export type TableColumnType = z.infer<typeof tableColumnTypeSchema>;

export const tableColumnSchema = z.object({
  name: z.string(),
  type: tableColumnTypeSchema,
});

export type TableColumn = z.infer<typeof tableColumnSchema>;

export const tableCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type TableCell = z.infer<typeof tableCellSchema>;

export const extractedTableSchema = z.object({
  name: z.string(),
  sheet: z.string().optional(),
  pageIndex: z.number().int().positive().optional(),
  columns: z.array(tableColumnSchema),
  // Each row holds one cell per column, in column order.
  rows: z.array(z.array(tableCellSchema)),
});

export type ExtractedTable = z.infer<typeof extractedTableSchema>;

export const extractedDocumentSchema = z.object({
  documentId: z.string(),
  kind: extractedDocumentKindSchema,
  method: extractionMethodSchema,
  confidence: extractionConfidenceSchema,
  pages: z.array(extractedPageSchema).default([]),
  tables: z.array(extractedTableSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

export type ExtractedDocumentInput = z.input<typeof extractedDocumentSchema>;
