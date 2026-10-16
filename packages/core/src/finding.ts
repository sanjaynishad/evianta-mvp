import { z } from "zod";

import { confidenceLevelSchema, evidenceSchema } from "./evidence.js";

export const openQuestionSeveritySchema = z.enum(["high", "medium", "low"]);

export type OpenQuestionSeverity = z.infer<typeof openQuestionSeveritySchema>;

export const openQuestionStatusSchema = z.enum(["open", "resolved", "dismissed"]);

export type OpenQuestionStatus = z.infer<typeof openQuestionStatusSchema>;

export const openQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  severity: openQuestionSeveritySchema,
  status: openQuestionStatusSchema.default("open"),
  resolutionNote: z.string().optional(),
  resolvedAt: z.string().optional(),
});

export type OpenQuestion = z.infer<typeof openQuestionSchema>;

export type OpenQuestionInput = z.input<typeof openQuestionSchema>;

export const findingSeveritySchema = z.enum(["high", "medium", "low", "info"]);

export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  severity: findingSeveritySchema.optional(),
  confidence: confidenceLevelSchema.optional(),
  evidence: z.array(evidenceSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(openQuestionSchema).default([]),
});

export type Finding = z.infer<typeof findingSchema>;

export type FindingInput = z.input<typeof findingSchema>;
