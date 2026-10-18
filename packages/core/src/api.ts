import { z } from "zod";

import { agentProfileSchema, agentRoleSchema, modelTierSchema } from "./agents.js";
import { caseSchema, caseStatusSchema, useCaseSchema } from "./case.js";
import { chatMessageSchema } from "./chat.js";
import { deliverableSchema, sectionReviewStatusSchema } from "./deliverable.js";
import {
  documentMetadataSchema,
  extractedDocumentKindSchema,
  extractedDocumentSchema,
  extractionMethodSchema,
} from "./document.js";
import { runEventTypes, type RunEventType } from "./events.js";
import { evidenceSchema } from "./evidence.js";
import { findingSchema, openQuestionSchema } from "./finding.js";
import { intakeModeSchema } from "./intake.js";
import {
  sourceConnectionSchema,
  sourceConnectorDefinitionSchema,
  sourceConnectorIdSchema,
  sourceItemSchema,
} from "./sources.js";
import { taskSchema } from "./task.js";
import { costEstimateSchema, tokenUsageSchema } from "./usage.js";

// Wire format of the HTTP API in apps/api. Responses are parsed leniently (unknown keys are
// dropped) so the server can add fields without breaking older clients.

export const visitorHeaderName = "X-Evianta-Visitor";

export const createCaseRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  // Optional so a chat can start before the kind of work is known; a run needs one.
  useCase: useCaseSchema.optional(),
  intakeMode: intakeModeSchema.optional(),
});

export type CreateCaseRequest = z.infer<typeof createCaseRequestSchema>;

// PATCH /cases/:id. Only while the case is unplanned.
export const updateCaseRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    useCase: useCaseSchema.optional(),
  })
  .refine(
    (update) =>
      update.title !== undefined ||
      update.description !== undefined ||
      update.useCase !== undefined,
    { message: "Provide a title, a description, or a use case" },
  );

export type UpdateCaseRequest = z.infer<typeof updateCaseRequestSchema>;

// PATCH /cases/:id/intake. Each field is one independent intake action.
export const updateIntakeRequestSchema = z
  .object({
    mode: intakeModeSchema.optional(),
    enabledConnectionIds: z.array(z.string().min(1)).max(20).optional(),
    skipItem: z.object({ itemId: z.string().min(1), skipped: z.boolean() }).optional(),
    assignDocument: z
      .object({ documentId: z.string().min(1), itemId: z.string().min(1).nullable() })
      .optional(),
    answerClarification: z
      .object({ id: z.string().min(1), answer: z.string().trim().max(1000) })
      .optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "Provide an intake change",
  });

export type UpdateIntakeRequest = z.infer<typeof updateIntakeRequestSchema>;

export const caseResponseSchema = z.object({ case: caseSchema });

export const chatMessageRequestSchema = z
  .object({
    text: z.string().trim().max(4000).default(""),
    documentIds: z.array(z.string().min(1)).max(50).default([]),
  })
  .refine((request) => request.text.length > 0 || request.documentIds.length > 0, {
    message: "Write a message or attach a file",
  });

export type ChatMessageRequest = z.input<typeof chatMessageRequestSchema>;

export const chatMessagesResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export type ChatMessagesResponse = z.infer<typeof chatMessagesResponseSchema>;

// Final frame of POST /cases/:id/messages: the stored reply and the case it updated.
export const chatReplyFrameSchema = z.object({
  message: chatMessageSchema,
  case: caseSchema,
});

export type ChatReplyFrame = z.infer<typeof chatReplyFrameSchema>;

export const sourceCatalogResponseSchema = z.object({
  connectors: z.array(sourceConnectorDefinitionSchema),
});

export const sourceConnectionsResponseSchema = z.object({
  connections: z.array(sourceConnectionSchema),
});

export const connectSourceRequestSchema = z.object({
  connectorId: sourceConnectorIdSchema,
});

export type ConnectSourceRequest = z.infer<typeof connectSourceRequestSchema>;

export const sourceItemsResponseSchema = z.object({
  items: z.array(sourceItemSchema),
});

export const sourceProposalActionRequestSchema = z.object({
  action: z.enum(["attach", "dismiss"]),
  proposalIds: z.array(z.string().min(1)).min(1).max(50),
});

export type SourceProposalActionRequest = z.infer<typeof sourceProposalActionRequestSchema>;

export const sourceImportRequestSchema = z.object({
  connectionId: z.string().min(1),
  itemId: z.string().min(1),
  checklistItemId: z.string().min(1).optional(),
});

export type SourceImportRequest = z.infer<typeof sourceImportRequestSchema>;

export const caseListResponseSchema = z.object({
  cases: z.array(caseSchema),
});

export type CaseListResponse = z.infer<typeof caseListResponseSchema>;

export const documentStatusSchema = z.enum(["pending", "processing", "ready", "partial", "failed"]);

export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const extractionSummarySchema = z.object({
  kind: extractedDocumentKindSchema,
  method: extractionMethodSchema,
  confidence: z.number().min(0).max(1),
  pageCount: z.number().int().nonnegative(),
  tableCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  // Handwritten or low-confidence pages (1-based) a reviewer should check.
  pagesNeedingReview: z.array(z.number().int().positive()).default([]),
  handwriting: z.boolean().default(false),
});

export type ExtractionSummary = z.infer<typeof extractionSummarySchema>;

// Document metadata without the storage path, plus its extraction state.
export const documentErrorCodes = [
  "unsupported-type",
  "ocr-unavailable",
  "ocr-failed",
  "ocr-partial",
  "extraction-failed",
  "read-failed",
] as const;

export type DocumentErrorCode = (typeof documentErrorCodes)[number];

export function isDocumentErrorCode(value: string | undefined): value is DocumentErrorCode {
  return (documentErrorCodes as readonly (string | undefined)[]).includes(value);
}

export const caseDocumentSchema = documentMetadataSchema.omit({ gcsPath: true }).extend({
  status: documentStatusSchema,
  // Client-safe message; provider and parser details stay in server logs.
  error: z.string().optional(),
  // Usually a DocumentErrorCode; kept as a string so a new server code does not break parsing.
  errorCode: z.string().optional(),
  extraction: extractionSummarySchema.optional(),
});

export type CaseDocument = z.infer<typeof caseDocumentSchema>;

export type CaseDocumentInput = z.input<typeof caseDocumentSchema>;

export const uploadDocumentsResponseSchema = z.object({
  documents: z.array(caseDocumentSchema),
});

export type UploadDocumentsResponse = z.infer<typeof uploadDocumentsResponseSchema>;

// Response to attaching or importing data-source items: the new documents and the updated case.
export const sourceAttachResponseSchema = z.object({
  documents: z.array(caseDocumentSchema),
  case: caseSchema,
});

export type SourceAttachResponse = z.infer<typeof sourceAttachResponseSchema>;

// GET /cases/:id/documents/:documentId. The extraction is absent until reading has produced one.
export const documentDetailResponseSchema = z.object({
  document: caseDocumentSchema,
  extraction: extractedDocumentSchema.optional(),
});

export type DocumentDetail = z.infer<typeof documentDetailResponseSchema>;

export type DocumentDetailInput = z.input<typeof documentDetailResponseSchema>;

export const caseCostSchema = z.object({
  tokenUsage: tokenUsageSchema,
  costEstimate: costEstimateSchema,
  runCount: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().optional(),
});

export type CaseCost = z.infer<typeof caseCostSchema>;

export const runEventTypeSchema = z
  .string()
  .refine((value): value is RunEventType => (runEventTypes as readonly string[]).includes(value));

export const runModeSchema = z.enum(["run", "retry"]);

export type RunMode = z.infer<typeof runModeSchema>;

export const caseRunStateSchema = z.object({
  active: z.boolean().default(false),
  // Seq of the newest persisted event; stream with `?after=` this value to see only new events.
  lastEventSeq: z.number().int().nonnegative().default(0),
  lastRunId: z.string().optional(),
  lastEventType: runEventTypeSchema.optional(),
  // Absent when the last run failed before it started.
  lastRunMode: runModeSchema.optional(),
  // Present when the last run ended with run-failed.
  lastRunError: z.string().optional(),
});

export type CaseRunState = z.infer<typeof caseRunStateSchema>;

export const caseStateSchema = z.object({
  case: caseSchema,
  tasks: z.array(taskSchema).default([]),
  findings: z.array(findingSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
  deliverables: z.array(deliverableSchema).default([]),
  documents: z.array(caseDocumentSchema).default([]),
  cost: caseCostSchema.optional(),
  run: caseRunStateSchema.default({}),
});

export type CaseState = z.infer<typeof caseStateSchema>;

export type CaseStateInput = z.input<typeof caseStateSchema>;

export const runStartResponseSchema = z.object({
  caseId: z.string().min(1),
  runId: z.string().min(1),
  mode: runModeSchema,
  streamUrl: z.string().min(1),
});

export type RunStartResponse = z.infer<typeof runStartResponseSchema>;

export const exportFormatSchema = z.enum(["docx", "xlsx", "json"]);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

const askUsageSchema = z.object({
  usage: tokenUsageSchema.optional(),
  cost: costEstimateSchema.optional(),
  retrievedFindingIds: z.array(z.string()).default([]),
});

// The `answer` frame of the POST /cases/:id/ask stream.
export const askResultSchema = z.discriminatedUnion("status", [
  askUsageSchema.extend({
    status: z.literal("answered"),
    answer: z.string(),
    evidenceIds: z.array(z.string()).default([]),
    findingIds: z.array(z.string()).default([]),
    evidence: z.array(evidenceSchema).default([]),
    modelTier: modelTierSchema.optional(),
  }),
  askUsageSchema.extend({
    status: z.literal("not-supported"),
    message: z.string(),
    evidenceIds: z.array(z.string()).default([]),
    findingIds: z.array(z.string()).default([]),
    canFlagForReview: z.boolean().default(true),
  }),
]);

export type AskResult = z.infer<typeof askResultSchema>;

export const askDeltaSchema = z.object({ text: z.string() });

export const sectionUpdateRequestSchema = z
  .object({
    // null clears a reviewer edit or comment.
    editedContent: z.string().max(200_000).nullable().optional(),
    reviewStatus: sectionReviewStatusSchema.optional(),
    reviewComment: z.string().trim().max(4000).nullable().optional(),
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
  note: z.string().trim().min(1).max(4000).optional(),
});

export type ReviewNoteRequest = z.infer<typeof reviewNoteRequestSchema>;

export const approveCaseRequestSchema = reviewNoteRequestSchema.extend({
  acknowledgeIncompleteReview: z.boolean().optional(),
});

export type ApproveCaseRequest = z.infer<typeof approveCaseRequestSchema>;

export const openQuestionUpdateResponseSchema = z.object({
  finding: findingSchema,
});

export const approveCaseResponseSchema = z.object({
  case: caseSchema,
  unresolvedQuestions: z.array(openQuestionSchema).default([]),
});

export type ApproveCaseResponse = z.infer<typeof approveCaseResponseSchema>;

export const sampleReadOnlyReason = "sample-read-only";

export const sampleReadOnlyErrorBodySchema = z.object({
  error: z.literal(sampleReadOnlyReason).optional(),
  reason: z.literal(sampleReadOnlyReason),
  copyUrl: z.string().min(1),
  message: z.string().optional(),
});

export type SampleReadOnlyErrorBody = z.infer<typeof sampleReadOnlyErrorBodySchema>;

// Every API error: a stable `error` code, a readable `message`, and optional details.
export const apiErrorBodySchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

// Error codes the web app reacts to; the API sends others too (see apps/api README).
export const apiErrorCodes = {
  runInProgress: "run-in-progress",
  nothingToRetry: "nothing-to-retry",
  uploadInProgress: "upload-in-progress",
  caseAlreadyPlanned: "case-already-planned",
  useCaseMissing: "use-case-missing",
  sampleReadOnly: sampleReadOnlyReason,
} as const;

export const agentDirectoryResponseSchema = z.object({
  roles: z.array(agentRoleSchema),
  agents: z.array(agentProfileSchema),
});

export type AgentDirectoryResponse = z.infer<typeof agentDirectoryResponseSchema>;

export const usageCaseRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  useCase: useCaseSchema.optional(),
  intakeMode: intakeModeSchema.optional(),
  status: caseStatusSchema,
  visitorId: z.string().optional(),
  isSample: z.boolean().default(false),
  isCopy: z.boolean().default(false),
  sourceCaseId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  approved: z.boolean().default(false),
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
  samples: z.number().int().nonnegative().default(0),
  copies: z.number().int().nonnegative().default(0),
  runs: z.number().int().nonnegative(),
  visitors: z.number().int().nonnegative(),
  tokenUsage: tokenUsageSchema,
  costEstimate: costEstimateSchema,
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const intakeModeTotalsSchema = z.object({
  cases: z.number().int().nonnegative(),
  // Cases that went on to a run.
  submitted: z.number().int().nonnegative(),
  // Drafts that moved here from the other entry mode.
  switchedIn: z.number().int().nonnegative().default(0),
});

export type IntakeModeTotals = z.infer<typeof intakeModeTotalsSchema>;

export const usageSummarySchema = z.object({
  totals: usageTotalsSchema,
  // Keyed by use case, plus "unspecified" for cases without one.
  byUseCase: z.record(z.string(), usageTotalsSchema).default({}),
  // Keyed by entry mode ("chat" or "form"), plus "unspecified" for cases from before entry modes.
  byIntakeMode: z.record(z.string(), intakeModeTotalsSchema).default({}),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;
