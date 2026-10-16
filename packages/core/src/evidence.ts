import { z } from "zod";

const unitInterval = z.number().min(0).max(1);

export const boundingBoxSchema = z.object({
  x: unitInterval,
  y: unitInterval,
  width: unitInterval,
  height: unitInterval,
});

export type BoundingBox = z.infer<typeof boundingBoxSchema>;

export const rowRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});

export type RowRange = z.infer<typeof rowRangeSchema>;

export const evidenceLocationSchema = z.object({
  page: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  cellRange: z.string().optional(),
  rowRange: rowRangeSchema.optional(),
  bbox: boundingBoxSchema.optional(),
  textQuote: z.string().optional(),
});

export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;

export const confidenceLevelSchema = z.enum(["high", "medium", "low", "unassessed"]);

export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;

export const evidenceSchema = z.object({
  id: z.string(),
  sourceRef: z.string(),
  description: z.string(),
  excerpt: z.string().optional(),
  documentId: z.string().optional(),
  location: evidenceLocationSchema.optional(),
  confidence: confidenceLevelSchema.optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export type EvidenceInput = z.input<typeof evidenceSchema>;
