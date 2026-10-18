import { AiError, emptyUsage, type AiClient, type Cost } from "@evianta/ai";
import {
  agentProfileSchema,
  agentRoleSchema,
  clarificationAnswerSchema,
  openQuestionSeveritySchema,
  useCaseSchema,
  withIntakeContext,
  type AgentRole,
  type Case,
  type DocumentMetadata,
  type ExtractedDocument,
  type ModelTier,
  type TokenUsage,
} from "@evianta/core";
import { z } from "zod";

import { defineAgent, silentLogger, type Agent, type AgentLogger } from "../agent.js";
import { validateTaskGraph } from "../dag.js";
import { referencePlanFor, type ReferencePlan } from "../plans.js";
import { truncate } from "../text.js";

export const coordinatorInputSchema = z.object({
  useCase: useCaseSchema,
  title: z.string(),
  description: z.string().optional(),
  clarifications: z.array(clarificationAnswerSchema).optional(),
  requestMessages: z.array(z.string()).optional(),
  documents: z.array(
    z.object({
      documentId: z.string(),
      name: z.string(),
      mimeType: z.string(),
      summary: z.string(),
    }),
  ),
  referencePlan: z.array(
    z.object({
      assignedRole: agentRoleSchema,
      title: z.string(),
      dependsOn: z.array(agentRoleSchema),
    }),
  ),
});

export type CoordinatorInput = z.infer<typeof coordinatorInputSchema>;

export const plannedTaskOutputSchema = z.object({
  assignedRole: agentRoleSchema,
  title: z.string(),
  dependsOn: z.array(agentRoleSchema).default([]),
  instructions: z.string().optional(),
});

export const planningQuestionSchema = z.object({
  text: z.string().min(1),
  severity: openQuestionSeveritySchema,
  assignedRole: agentRoleSchema.optional(),
});

export type PlanningQuestion = z.infer<typeof planningQuestionSchema>;

export const coordinatorOutputSchema = z.object({
  tasks: z.array(plannedTaskOutputSchema),
  openQuestions: z.array(planningQuestionSchema).default([]),
  notes: z.string().optional(),
});

export type CoordinatorOutput = z.infer<typeof coordinatorOutputSchema>;

export const coordinatorProfile = agentProfileSchema.parse({
  role: "coordinator",
  displayName: "Coordinator",
  specialty: "Case planning and delegation",
  summary:
    "Plans each case into a dependency-ordered set of specialist tasks and adapts the plan to the uploaded documents.",
  capabilities: [
    "Task planning from a reference workflow",
    "Delegation to specialist agents",
    "Flagging missing documents before work starts",
  ],
  tools: [],
  procedures: [
    "Start from the reference plan for the use case",
    "Keep every required specialist and review task",
    "Raise open questions for missing or unclear inputs",
  ],
  outputFormats: ["task plan"],
  limitations: ["Cannot remove required specialist or review tasks"],
  modelTier: "mid",
});

export const COORDINATOR_SYSTEM_PROMPT = [
  "You are the coordinator of a professional workspace. Plan the case into specialist tasks.",
  "Start from referencePlan. Return one entry per reference task with the same assignedRole and dependsOn. You may refine the title and add short instructions that point the specialist at the relevant uploaded documents.",
  "requestMessages are what the user typed while setting up the case, oldest first. Where a later message corrects the description, an earlier message, or a clarification (for example a different assessment year or period), follow the later message.",
  "Do not remove, merge, or add tasks, and do not introduce dependency cycles.",
  "Add openQuestions (with severity, and assignedRole when one task owns it) for missing, unreadable, or inconsistent inputs, for example a ledger the plan needs but nobody uploaded.",
  "Keep notes brief.",
].join("\n");

export type CoordinatorAgent = Agent<CoordinatorInput, CoordinatorOutput>;

export function createCoordinatorAgent(): CoordinatorAgent {
  return defineAgent<CoordinatorInput, CoordinatorOutput>({
    role: "coordinator",
    modelTier: "mid",
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    inputSchema: coordinatorInputSchema,
    outputSchema: coordinatorOutputSchema,
    maxOutputTokens: 2048,
    profile: coordinatorProfile,
  });
}

export interface PlannedTaskDraft {
  assignedRole: AgentRole;
  title: string;
  dependsOn: AgentRole[];
  instructions?: string;
}

export interface PlanDraft {
  tasks: PlannedTaskDraft[];
  openQuestions: PlanningQuestion[];
  notes?: string;
  /** "reference" when the model output was missing or invalid and the reference plan was used. */
  source: "model" | "reference";
  issues: string[];
}

export function referencePlanDraft(plan: ReferencePlan, issues: string[] = []): PlanDraft {
  return {
    tasks: plan.tasks.map((task) => ({
      assignedRole: task.assignedRole,
      title: task.title,
      dependsOn: [...task.dependsOn],
    })),
    openQuestions: [],
    source: "reference",
    issues,
  };
}

/**
 * Adapts the reference plan with the model's titles, instructions, extra dependencies, and open
 * questions. Required tasks are always kept; invalid output falls back to the reference plan.
 */
export function mergeWithReferencePlan(
  plan: ReferencePlan,
  output: CoordinatorOutput | undefined,
): PlanDraft {
  if (!output) {
    return referencePlanDraft(plan, ["The coordinator returned no plan."]);
  }

  const planRoles = new Set<AgentRole>(plan.tasks.map((task) => task.assignedRole));
  const seen = new Set<AgentRole>();
  const issues: string[] = [];

  for (const task of output.tasks) {
    if (seen.has(task.assignedRole)) {
      return referencePlanDraft(plan, [
        `The coordinator assigned "${task.assignedRole}" more than once; using the reference plan.`,
      ]);
    }

    seen.add(task.assignedRole);

    if (!planRoles.has(task.assignedRole)) {
      issues.push(`Dropped "${task.assignedRole}", which is not part of this use case.`);
    }
  }

  const tasks = plan.tasks.map((reference): PlannedTaskDraft => {
    const proposed = output.tasks.find((task) => task.assignedRole === reference.assignedRole);

    if (!proposed) {
      issues.push(`Restored the required "${reference.assignedRole}" task.`);

      return {
        assignedRole: reference.assignedRole,
        title: reference.title,
        dependsOn: [...reference.dependsOn],
      };
    }

    const extraDependencies = proposed.dependsOn.filter(
      (role) => planRoles.has(role) && !reference.dependsOn.includes(role),
    );
    const unknownDependencies = proposed.dependsOn.filter((role) => !planRoles.has(role));

    if (unknownDependencies.length > 0) {
      issues.push(
        `Ignored unknown dependencies of "${reference.assignedRole}": ${unknownDependencies.join(", ")}.`,
      );
    }

    const title = proposed.title.trim();
    const instructions = proposed.instructions?.trim();

    return {
      assignedRole: reference.assignedRole,
      title: title.length > 0 ? truncate(title, 160) : reference.title,
      dependsOn: [...new Set([...reference.dependsOn, ...extraDependencies])],
      ...(instructions ? { instructions: truncate(instructions, 1200) } : {}),
    };
  });

  try {
    validateTaskGraph(tasks.map((task) => ({ id: task.assignedRole, dependsOn: task.dependsOn })));
  } catch (error) {
    return referencePlanDraft(plan, [
      `${error instanceof Error ? error.message : String(error)} Using the reference plan.`,
    ]);
  }

  const openQuestions = output.openQuestions.filter(
    (question) => question.assignedRole === undefined || planRoles.has(question.assignedRole),
  );
  const notes = output.notes?.trim();

  return {
    tasks,
    openQuestions,
    ...(notes ? { notes: truncate(notes, 1200) } : {}),
    source: "model",
    issues,
  };
}

export function summarizeDocument(
  metadata: DocumentMetadata,
  extraction: ExtractedDocument | undefined,
): string {
  if (!extraction) {
    return "Not extracted yet.";
  }

  const parts: string[] = [`${extraction.kind}, ${extraction.method}`];

  if (extraction.pages.length > 0) {
    parts.push(`${extraction.pages.length} page(s)`);
  }

  for (const table of extraction.tables.slice(0, 3)) {
    const columns = table.columns
      .slice(0, 12)
      .map((column) => column.name)
      .join(", ");

    parts.push(`table "${table.name}" with ${table.rows.length} row(s): ${columns}`);
  }

  if (extraction.confidence < 0.6) {
    parts.push(`low extraction confidence (${extraction.confidence.toFixed(2)})`);
  }

  if (extraction.warnings.length > 0) {
    parts.push(`warnings: ${extraction.warnings.slice(0, 3).join("; ")}`);
  }

  const opening = extraction.pages[0]?.text.replace(/\s+/g, " ").trim();

  if (opening) {
    parts.push(`opens with: "${truncate(opening, 240)}"`);
  }

  return truncate(`${metadata.name}: ${parts.join("; ")}`, 900);
}

export interface PlanCaseInput {
  caseRecord: Case;
  documents: ReadonlyArray<{ metadata: DocumentMetadata; extraction?: ExtractedDocument }>;
  ai: AiClient;
  agent?: CoordinatorAgent;
  logger?: AgentLogger;
}

export interface PlanCaseResult {
  plan: PlanDraft;
  usage: TokenUsage;
  cost: Cost;
  modelTier: ModelTier;
}

/** Runs the coordinator and merges its output with the reference plan. Never throws on model errors. */
export async function planWithCoordinatorAsync(input: PlanCaseInput): Promise<PlanCaseResult> {
  const { caseRecord, ai } = input;
  const agent = input.agent ?? createCoordinatorAgent();
  const logger = input.logger ?? silentLogger;

  if (!caseRecord.useCase) {
    throw new Error(`Case "${caseRecord.id}" has no use case to plan.`);
  }

  const reference = referencePlanFor(caseRecord.useCase);
  const agentInput: CoordinatorInput = {
    useCase: caseRecord.useCase,
    title: caseRecord.title,
    description: caseRecord.description,
    ...withIntakeContext(caseRecord.intake),
    documents: input.documents.map(({ metadata, extraction }) => ({
      documentId: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      summary: summarizeDocument(metadata, extraction),
    })),
    referencePlan: reference.tasks.map((task) => ({
      assignedRole: task.assignedRole,
      title: task.title,
      dependsOn: [...task.dependsOn],
    })),
  };

  try {
    const result = await agent.runAsync(agentInput, {
      ai,
      case: caseRecord,
      documents: [],
      logger,
    });

    return {
      plan: mergeWithReferencePlan(reference, result.output),
      usage: result.usage,
      cost: result.cost,
      modelTier: result.modelTier,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.warn("Coordinator planning failed; using the reference plan.", { error: message });

    return {
      plan: referencePlanDraft(reference, [`Coordinator planning failed: ${message}`]),
      usage: error instanceof AiError ? error.usage : emptyUsage(),
      cost: error instanceof AiError ? error.cost : 0,
      modelTier: agent.modelTier,
    };
  }
}
