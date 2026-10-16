import { z } from "zod";

import { agentProfileSchema, agentRoleSchema } from "./agents.js";
import { caseSchema, caseStatusSchema, useCaseSchema } from "./case.js";
import { deliverableSchema, sectionReviewStatusSchema } from "./deliverable.js";
import { documentMetadataSchema, extractionMethodSchema } from "./document.js";
import { evidenceSchema } from "./evidence.js";
import { findingSchema } from "./finding.js";
import { taskSchema } from "./task.js";
import { costEstimateSchema, tokenUsageSchema } from "./usage.js";

export const visitorHeaderName = "X-Evianta-Visitor";

export const createCaseRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  useCase: useCaseSchema,
});

export type CreateCaseRequest = z.infer<typeof createCaseRequestSchema>;

export const caseListResponseSchema = z.object({
  cases: z.array(caseSchema),
});

export type CaseListResponse = z.infer<typeof caseListResponseSchema>;

export const documentProcessingStatusSchema = z.enum([
  "queued",
  "reading-text",
  "ocr",
  "ready",
  "failed",
]);

export type DocumentProcessingStatus = z.infer<typeof documentProcessingStatusSchema>;

export const documentProcessingSchema = z.object({
  status: documentProcessingStatusSchema,
  method: extractionMethodSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  handwritingDetected: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
});

export type DocumentProcessing = z.infer<typeof documentProcessingSchema>;

export const caseDocumentSchema = documentMetadataSchema.extend({
  processing: documentProcessingSchema.optional(),
});

export type CaseDocument = z.infer<typeof caseDocumentSchema>;

export type CaseDocumentInput = z.input<typeof caseDocumentSchema>;

export const runModeSchema = z.enum(["run", "retry"]);

export type RunMode = z.infer<typeof runModeSchema>;

export const runStatusSchema = z.enum(["running", "completed", "failed"]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSummarySchema = z.object({
  runId: z.string().min(1),
  mode: runModeSchema.default("run"),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  lastEventSeq: z.number().int().nonnegative().default(0),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

export const caseStateSchema = z.object({
  case: caseSchema,
  tasks: z.array(taskSchema).default([]),
  findings: z.array(findingSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
  deliverables: z.array(deliverableSchema).default([]),
  documents: z.array(caseDocumentSchema).default([]),
  latestRun: runSummarySchema.optional(),
});

export type CaseState = z.infer<typeof caseStateSchema>;

export type CaseStateInput = z.input<typeof caseStateSchema>;

export const runStartResponseSchema = z.object({
  runId: z.string().min(1),
});

export type RunStartResponse = z.infer<typeof runStartResponseSchema>;

export const exportFormatSchema = z.enum(["docx", "xlsx", "json"]);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

export const askResponseSchema = z.object({
  answer: z.string(),
  supported: z.boolean(),
  findingIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export type AskResponse = z.infer<typeof askResponseSchema>;

export const sectionUpdateRequestSchema = z
  .object({
    editedContent: z.string().optional(),
    reviewStatus: sectionReviewStatusSchema.optional(),
    reviewComment: z.string().optional(),
  })
  .refine(
    (update) =>
      update.editedContent !== undefined ||
      update.reviewStatus !== undefined ||
      update.reviewComment !== undefined,
    { message: "Provide an edit, a review status, or a comment" },
  );

export type SectionUpdateRequest = z.infer<typeof sectionUpdateRequestSchema>;

export const reviewNoteRequestSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export type ReviewNoteRequest = z.infer<typeof reviewNoteRequestSchema>;

export const sampleReadOnlyReason = "sample-read-only";

export const sampleReadOnlyErrorBodySchema = z.object({
  reason: z.literal(sampleReadOnlyReason),
  copyUrl: z.string().min(1),
  message: z.string().optional(),
});

export type SampleReadOnlyErrorBody = z.infer<typeof sampleReadOnlyErrorBodySchema>;

export const apiErrorBodySchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const agentDirectoryResponseSchema = z.object({
  roles: z.array(agentRoleSchema),
  agents: z.array(agentProfileSchema),
});

export type AgentDirectoryResponse = z.infer<typeof agentDirectoryResponseSchema>;

export const usageCaseRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  useCase: useCaseSchema.optional(),
  status: caseStatusSchema,
  visitorId: z.string().optional(),
  isSample: z.boolean().default(false),
  sourceCaseId: z.string().optional(),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  documentCount: z.number().int().nonnegative().default(0),
  runCount: z.number().int().nonnegative().default(0),
  tokenUsage: tokenUsageSchema,
  costEstimate: costEstimateSchema.default(0),
});

export type UsageCaseRow = z.infer<typeof usageCaseRowSchema>;

export const usageCasesResponseSchema = z.object({
  cases: z.array(usageCaseRowSchema),
  nextCursor: z.string().optional(),
});

export type UsageCasesResponse = z.infer<typeof usageCasesResponseSchema>;

export const usageTotalsSchema = z.object({
  cases: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  visitors: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costEstimate: costEstimateSchema,
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const usageSummarySchema = z.object({
  totals: usageTotalsSchema,
  byUseCase: z.array(usageTotalsSchema.extend({ useCase: useCaseSchema })).default([]),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;
