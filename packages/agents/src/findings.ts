import {
  confidenceLevelSchema,
  deliverableFormatSchema,
  deliverableSectionKindSchema,
  findingDateSchema,
  findingFigureSchema,
  findingSeveritySchema,
  openQuestionSeveritySchema,
} from "@evianta/core";
import { z } from "zod";

export const evidenceReferenceSchema = z.object({
  /** Id of an uploaded case document. Either documentId or url is required. */
  documentId: z.string().optional(),
  /** Source URL from grounding citations, for research agents. */
  url: z.string().optional(),
  description: z.string(),
  page: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  cellRange: z.string().optional(),
  rowStart: z.number().int().positive().optional(),
  rowEnd: z.number().int().positive().optional(),
  textQuote: z.string().optional(),
  confidence: confidenceLevelSchema.optional(),
});

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const openQuestionDraftSchema = z.object({
  text: z.string().min(1),
  severity: openQuestionSeveritySchema,
});

export type OpenQuestionDraft = z.infer<typeof openQuestionDraftSchema>;

export const agentFindingSchema = z.object({
  summary: z.string().min(1),
  detail: z.string().optional(),
  severity: findingSeveritySchema,
  confidence: confidenceLevelSchema,
  evidence: z.array(evidenceReferenceSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(openQuestionDraftSchema).default([]),
  figures: z.array(findingFigureSchema).optional(),
  dates: z.array(findingDateSchema).optional(),
});

export type AgentFinding = z.infer<typeof agentFindingSchema>;

export type AgentFindingInput = z.input<typeof agentFindingSchema>;

export const sectionDraftSchema = z.object({
  title: z.string().min(1),
  kind: deliverableSectionKindSchema.default("text"),
  content: z.string(),
  /** Indexes into the task's findings that this section relies on; all findings when omitted. */
  findingIndexes: z.array(z.number().int().nonnegative()).optional(),
});

export type SectionDraft = z.infer<typeof sectionDraftSchema>;

export const specialistOutputSchema = z.object({
  findings: z.array(agentFindingSchema),
  /** Questions about the task as a whole rather than a single finding. */
  openQuestions: z.array(openQuestionDraftSchema).default([]),
  section: sectionDraftSchema.optional(),
});

export type SpecialistOutput = z.infer<typeof specialistOutputSchema>;

export type SpecialistOutputInput = z.input<typeof specialistOutputSchema>;

export const PRIMARY_DELIVERABLE_KEY = "primary";

export const deliverableSpecSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  format: deliverableFormatSchema,
  content: z.string().optional(),
});

export type DeliverableSpec = z.infer<typeof deliverableSpecSchema>;
