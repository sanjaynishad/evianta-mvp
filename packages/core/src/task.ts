import { z } from "zod";

import { agentRoleSchema } from "./agents.js";
import { costEstimateSchema, tokenUsageSchema } from "./usage.js";

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
  tokenUsage: tokenUsageSchema.optional(),
  costEstimate: costEstimateSchema.optional(),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
});

export type Task = z.infer<typeof taskSchema>;

export type TaskInput = z.input<typeof taskSchema>;
