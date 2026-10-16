import { z } from "zod";

import { costEstimateSchema } from "./usage.js";

export const useCaseSchema = z.enum(["data-analysis", "tax-notice", "msme-payment"]);

export type UseCase = z.infer<typeof useCaseSchema>;

export const caseStatusSchema = z.enum([
  "draft",
  "planning",
  "in-progress",
  "review",
  "completed",
  "failed",
]);

export type CaseStatus = z.infer<typeof caseStatusSchema>;

export const caseApprovalSchema = z.object({
  approvedAt: z.string(),
  unresolvedQuestionIds: z.array(z.string()).default([]),
  note: z.string().optional(),
});

export type CaseApproval = z.infer<typeof caseApprovalSchema>;

export const caseUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costEstimate: costEstimateSchema.default(0),
  runCount: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().optional(),
});

export type CaseUsage = z.infer<typeof caseUsageSchema>;

export const caseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  useCase: useCaseSchema.optional(),
  status: caseStatusSchema.default("draft"),
  visitorId: z.string().optional(),
  isSample: z.boolean().default(false),
  sourceCaseId: z.string().optional(),
  approval: caseApprovalSchema.optional(),
  usage: caseUsageSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Case = z.infer<typeof caseSchema>;

export type CaseInput = z.input<typeof caseSchema>;
