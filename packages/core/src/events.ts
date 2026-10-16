import { z } from "zod";

import { agentRoleSchema } from "./agents.js";
import { findingSeveritySchema } from "./finding.js";
import { costEstimateSchema, tokenUsageSchema } from "./usage.js";

const runEventBaseSchema = z.object({
  caseId: z.string(),
  runId: z.string(),
  // Monotonically increasing per case, starting at 1; doubles as the SSE event id.
  seq: z.number().int().positive(),
  timestamp: z.string(),
});

export const runStartedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run-started"),
  mode: z.enum(["run", "retry"]).default("run"),
  taskIds: z.array(z.string()).default([]),
});

export const taskStartedEventSchema = runEventBaseSchema.extend({
  type: z.literal("task-started"),
  taskId: z.string(),
  title: z.string(),
  assignedRole: agentRoleSchema,
  attempt: z.number().int().positive(),
});

export const taskCompletedEventSchema = runEventBaseSchema.extend({
  type: z.literal("task-completed"),
  taskId: z.string(),
  findingIds: z.array(z.string()).default([]),
  tokenUsage: tokenUsageSchema.optional(),
  costEstimate: costEstimateSchema.optional(),
  // Case cost so far, including earlier runs.
  runningCostEstimate: costEstimateSchema.optional(),
});

export const taskFailedEventSchema = runEventBaseSchema.extend({
  type: z.literal("task-failed"),
  taskId: z.string(),
  error: z.string(),
  blockedTaskIds: z.array(z.string()).default([]),
});

export const findingAddedEventSchema = runEventBaseSchema.extend({
  type: z.literal("finding-added"),
  taskId: z.string(),
  findingId: z.string(),
  summary: z.string(),
  severity: findingSeveritySchema.optional(),
});

export const costUpdatedEventSchema = runEventBaseSchema.extend({
  type: z.literal("cost-updated"),
  taskId: z.string().optional(),
  totalTokenUsage: tokenUsageSchema,
  totalCostEstimate: costEstimateSchema,
});

export const runCompletedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run-completed"),
  deliverableIds: z.array(z.string()).default([]),
  totalTokenUsage: tokenUsageSchema,
  totalCostEstimate: costEstimateSchema,
});

export const runFailedEventSchema = runEventBaseSchema.extend({
  type: z.literal("run-failed"),
  error: z.string(),
  failedTaskIds: z.array(z.string()).default([]),
  totalTokenUsage: tokenUsageSchema.optional(),
  totalCostEstimate: costEstimateSchema.optional(),
});

export const runEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  taskStartedEventSchema,
  taskCompletedEventSchema,
  taskFailedEventSchema,
  findingAddedEventSchema,
  costUpdatedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
]);

export type RunEvent = z.infer<typeof runEventSchema>;

export type RunEventInput = z.input<typeof runEventSchema>;

export type RunEventType = RunEvent["type"];

export const runEventTypes: readonly RunEventType[] = runEventSchema.options.map(
  (option) => option.shape.type.value,
);

export type RunEventOfType<TType extends RunEventType> = Extract<RunEvent, { type: TType }>;

export type RunStartedEvent = RunEventOfType<"run-started">;
export type TaskStartedEvent = RunEventOfType<"task-started">;
export type TaskCompletedEvent = RunEventOfType<"task-completed">;
export type TaskFailedEvent = RunEventOfType<"task-failed">;
export type FindingAddedEvent = RunEventOfType<"finding-added">;
export type CostUpdatedEvent = RunEventOfType<"cost-updated">;
export type RunCompletedEvent = RunEventOfType<"run-completed">;
export type RunFailedEvent = RunEventOfType<"run-failed">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewRunEvent = DistributiveOmit<RunEventInput, "caseId" | "seq" | "timestamp"> & {
  timestamp?: string;
};

export function isTerminalRunEvent(event: RunEvent): event is RunCompletedEvent | RunFailedEvent {
  return event.type === "run-completed" || event.type === "run-failed";
}
