import { z } from "zod";

export const agentRoleSchema = z.enum([
  "coordinator",
  "business-data-analyst",
  "case-analysis",
  "reconciliation",
  "tax-research",
  "response-preparation",
  "document-analysis",
  "payment-reconciliation",
  "evidence-analysis",
  "legal-research",
  "case-preparation",
  "independent-review",
]);

export type AgentRole = z.infer<typeof agentRoleSchema>;

export const evidenceSchema = z.object({
  id: z.string(),
  sourceRef: z.string(),
  description: z.string(),
  excerpt: z.string().optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  evidence: z.array(evidenceSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type Finding = z.infer<typeof findingSchema>;

export const taskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "blocked",
  "completed",
  "failed",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  assignedRole: agentRoleSchema,
  status: taskStatusSchema.default("pending"),
  dependsOn: z.array(z.string()).default([]),
});

export type Task = z.infer<typeof taskSchema>;

export const deliverableSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  title: z.string(),
  format: z.enum(["document", "report", "spreadsheet", "dashboard"]),
  content: z.string().optional(),
});

export type Deliverable = z.infer<typeof deliverableSchema>;

export const caseStatusSchema = z.enum(["draft", "planning", "in-progress", "review", "completed"]);

export type CaseStatus = z.infer<typeof caseStatusSchema>;

export const caseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: caseStatusSchema.default("draft"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Case = z.infer<typeof caseSchema>;
