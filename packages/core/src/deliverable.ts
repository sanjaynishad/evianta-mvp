import { z } from "zod";

import { agentRoleSchema, modelTierSchema } from "./agents.js";

export const deliverableSectionKindSchema = z.enum(["text", "table", "chart", "timeline"]);

export type DeliverableSectionKind = z.infer<typeof deliverableSectionKindSchema>;

export const sectionReviewStatusSchema = z.enum(["pending", "approved", "needs-changes"]);

export type SectionReviewStatus = z.infer<typeof sectionReviewStatusSchema>;

export const deliverableSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: deliverableSectionKindSchema,
  content: z.string(),
  editedContent: z.string().optional(),
  editedAt: z.string().optional(),
  producedByRole: agentRoleSchema,
  modelTier: modelTierSchema.optional(),
  findingIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  reviewStatus: sectionReviewStatusSchema.default("pending"),
  reviewComment: z.string().optional(),
  reviewedAt: z.string().optional(),
});

export type DeliverableSection = z.infer<typeof deliverableSectionSchema>;

export type DeliverableSectionInput = z.input<typeof deliverableSectionSchema>;

export const deliverableFormatSchema = z.enum(["document", "report", "spreadsheet", "dashboard"]);

export type DeliverableFormat = z.infer<typeof deliverableFormatSchema>;

export const deliverableSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  format: deliverableFormatSchema,
  content: z.string().optional(),
  sections: z.array(deliverableSectionSchema).default([]),
});

export type Deliverable = z.infer<typeof deliverableSchema>;

export type DeliverableInput = z.input<typeof deliverableSchema>;
