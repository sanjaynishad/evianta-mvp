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

export const figureComponentSchema = z.object({
  label: z.string(),
  value: z.number(),
});

export type FigureComponent = z.infer<typeof figureComponentSchema>;

// A figure stated by a finding. When components are present, value is claimed to equal their sum,
// so deterministic verification can recompute it. Figures sharing a key must agree across tasks.
export const findingFigureSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  value: z.number(),
  unit: z.string().optional(),
  components: z.array(figureComponentSchema).optional(),
});

export type FindingFigure = z.infer<typeof findingFigureSchema>;

export const findingDateSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  date: z.string(),
});

export type FindingDate = z.infer<typeof findingDateSchema>;

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
  figures: z.array(findingFigureSchema).optional(),
  dates: z.array(findingDateSchema).optional(),
  // Attempt of the producing task; readers use only the task's latest completed attempt.
  attempt: z.number().int().positive().optional(),
});

export type Finding = z.infer<typeof findingSchema>;

export type FindingInput = z.input<typeof findingSchema>;
