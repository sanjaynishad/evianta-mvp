import { VERIFY_AGAINST_CURRENT_LAW, type AiClient, type Cost } from "@evianta/ai";
import type {
  AgentRole,
  Case,
  Citation,
  DocumentMetadata,
  ExtractedDocument,
  Finding,
  ModelTier,
  Task,
  TokenUsage,
} from "@evianta/core";

import type { Agent, AgentContext, AgentLogger, AgentResult, AnyAgent } from "./agent.js";
import type { SpecialistInput, PriorFinding } from "./agents/specialist.js";
import type {
  AgentFindingInput,
  DeliverableSpec,
  OpenQuestionDraft,
  SectionDraft,
  SpecialistOutput,
} from "./findings.js";
import type { DocumentSlice } from "./slices.js";
import { truncate } from "./text.js";

export interface AgentLookup {
  get(role: AgentRole): AnyAgent | undefined;
  require(role: AgentRole): AnyAgent;
}

export interface DependencyResult {
  task: Task;
  findings: Finding[];
}

export interface UpstreamSection {
  taskId: string;
  taskTitle: string;
  role: AgentRole;
  deliverableId: string;
  title: string;
  content: string;
}

export interface TaskExecutionContext {
  ai: AiClient;
  case: Case;
  task: Task;
  attempt: number;
  /** Every task in the case plan. */
  tasks: readonly Task[];
  /** Direct dependencies and their findings. */
  dependencies: readonly DependencyResult[];
  /** Findings of every upstream task, direct or transitive, in plan order. */
  upstreamFindings: readonly Finding[];
  /** Deliverable sections drafted by upstream tasks, in plan order, with reviewer edits applied. */
  upstreamSections: readonly UpstreamSection[];
  /** Relevant document slices within the task's token budget. */
  documents: readonly DocumentSlice[];
  documentMetadata: readonly DocumentMetadata[];
  /** Full cached extraction, for deterministic pre-steps that must not go to the model whole. */
  loadExtractionAsync(documentId: string): Promise<ExtractedDocument | undefined>;
  agents: AgentLookup;
  logger: AgentLogger;
}

export interface TaskSectionDraft extends SectionDraft {
  /** Target deliverable; the primary deliverable when omitted. */
  deliverableKey?: string;
}

export interface TaskOutput {
  findings: AgentFindingInput[];
  /** Questions about the task as a whole; stored on a dedicated finding. */
  openQuestions?: OpenQuestionDraft[];
  sections?: TaskSectionDraft[];
  /** Extra deliverables referenced by section deliverableKey, for example a dashboard. */
  deliverables?: DeliverableSpec[];
  usage: TokenUsage;
  cost: Cost;
  modelTier?: ModelTier;
  citations?: Citation[];
  needsVerification?: boolean;
}

/** Executes one planned task. Handlers never persist; the orchestrator stores their output. */
export interface TaskHandler {
  role: AgentRole;
  executeAsync(ctx: TaskExecutionContext): Promise<TaskOutput>;
}

export interface TaskHandlerRegistry {
  get(role: AgentRole): TaskHandler | undefined;
  /** Adds or replaces the handler for its role. */
  register(handler: TaskHandler): TaskHandlerRegistry;
  roles(): AgentRole[];
}

export function createTaskHandlerRegistry(
  handlers: readonly TaskHandler[] = [],
): TaskHandlerRegistry {
  const byRole = new Map<AgentRole, TaskHandler>();
  const registry: TaskHandlerRegistry = {
    get(role) {
      return byRole.get(role);
    },
    register(handler) {
      byRole.set(handler.role, handler);

      return registry;
    },
    roles() {
      return [...byRole.keys()];
    },
  };

  for (const handler of handlers) {
    registry.register(handler);
  }

  return registry;
}

export function agentContextFor(ctx: TaskExecutionContext): AgentContext {
  return {
    ai: ctx.ai,
    case: ctx.case,
    task: ctx.task,
    documents: [...ctx.documents],
    logger: ctx.logger,
  };
}

export const MAX_PRIOR_FINDINGS = 40;

export function toPriorFindings(ctx: TaskExecutionContext): PriorFinding[] {
  const tasksById = new Map(ctx.tasks.map((task) => [task.id, task]));

  return ctx.upstreamFindings.slice(-MAX_PRIOR_FINDINGS).map((finding) => {
    const task = tasksById.get(finding.taskId);

    return {
      findingId: finding.id,
      taskTitle: task?.title ?? finding.taskId,
      role: task?.assignedRole ?? ctx.task.assignedRole,
      summary: truncate(finding.summary, 400),
      ...(finding.detail ? { detail: truncate(finding.detail, 800) } : {}),
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.figures ? { figures: finding.figures } : {}),
      ...(finding.dates ? { dates: finding.dates } : {}),
      ...(finding.openQuestions.length > 0
        ? {
            openQuestions: finding.openQuestions.slice(0, 10).map((question) => ({
              text: truncate(question.text, 400),
              severity: question.severity,
              status: question.status,
            })),
          }
        : {}),
      evidence: finding.evidence.slice(0, 5).map((item) => ({
        evidenceId: item.id,
        sourceRef: item.sourceRef,
        ...(item.documentId ? { documentId: item.documentId } : {}),
        ...(item.location?.textQuote ? { textQuote: truncate(item.location.textQuote, 200) } : {}),
      })),
    };
  });
}

export function buildSpecialistInput(
  ctx: TaskExecutionContext,
  context?: Record<string, unknown>,
): SpecialistInput {
  return {
    role: ctx.task.assignedRole,
    case: {
      title: ctx.case.title,
      ...(ctx.case.description ? { description: ctx.case.description } : {}),
      ...(ctx.case.useCase ? { useCase: ctx.case.useCase } : {}),
    },
    task: {
      title: ctx.task.title,
      ...(ctx.task.instructions ? { instructions: ctx.task.instructions } : {}),
    },
    priorFindings: toPriorFindings(ctx),
    documents: ctx.documents.map((slice) => ({ ...slice })),
    ...(context ? { context } : {}),
  };
}

export function specialistResultToTaskOutput(
  result: AgentResult<SpecialistOutput>,
  grounding: boolean,
): TaskOutput {
  const openQuestions = [...result.output.openQuestions];

  if (grounding && result.needsVerification) {
    openQuestions.push({
      text: `${VERIFY_AGAINST_CURRENT_LAW}: the research returned no cited sources, so every claim in it needs professional verification.`,
      severity: "high",
    });
  }

  return {
    findings: result.output.findings,
    openQuestions,
    sections: result.output.section ? [result.output.section] : [],
    usage: result.usage,
    cost: result.cost,
    modelTier: result.modelTier,
    citations: result.citations,
    needsVerification: result.needsVerification,
  };
}

export type SpecialistAgentLike = Agent<SpecialistInput, SpecialistOutput>;

export interface SpecialistTaskHooks {
  /** Deterministic pre-step (no model cost); the result is passed to the agent as `context`. */
  prepareContextAsync?(ctx: TaskExecutionContext): Promise<Record<string, unknown> | undefined>;
  /** Adjusts the default agent input, for example to replace document slices. */
  prepareInputAsync?(ctx: TaskExecutionContext, input: SpecialistInput): Promise<SpecialistInput>;
  /** Adjusts the output before it is persisted, for example to add deterministic findings. */
  postProcessAsync?(
    output: TaskOutput,
    ctx: TaskExecutionContext,
    result: AgentResult<SpecialistOutput>,
  ): Promise<TaskOutput>;
}

/**
 * Runs a specialist agent with the generic findings schema. Pass a role to resolve the agent from
 * the registry at run time, or an agent to pin it.
 */
export function createSpecialistTaskHandler(
  agentOrRole: SpecialistAgentLike | AgentRole,
  hooks: SpecialistTaskHooks = {},
): TaskHandler {
  const role = typeof agentOrRole === "string" ? agentOrRole : agentOrRole.role;

  return {
    role,
    async executeAsync(ctx) {
      const agent: SpecialistAgentLike =
        typeof agentOrRole === "string" ? ctx.agents.require(role) : agentOrRole;
      const context = await hooks.prepareContextAsync?.(ctx);
      const defaultInput = buildSpecialistInput(ctx, context);
      const input = hooks.prepareInputAsync
        ? await hooks.prepareInputAsync(ctx, defaultInput)
        : defaultInput;
      const result = await agent.runAsync(input, agentContextFor(ctx));
      const output = specialistResultToTaskOutput(result, agent.grounding === true);

      return hooks.postProcessAsync ? hooks.postProcessAsync(output, ctx, result) : output;
    },
  };
}

export interface AgentTaskHooks<I, O> {
  prepareInputAsync(ctx: TaskExecutionContext): Promise<I>;
  toTaskOutput(result: AgentResult<O>, ctx: TaskExecutionContext): TaskOutput | Promise<TaskOutput>;
}

/** Runs any agent with a custom input and output mapping. */
export function createAgentTaskHandler<I, O>(
  agent: Agent<I, O>,
  hooks: AgentTaskHooks<I, O>,
): TaskHandler {
  return {
    role: agent.role,
    async executeAsync(ctx) {
      const input = await hooks.prepareInputAsync(ctx);
      const result = await agent.runAsync(input, agentContextFor(ctx));

      return hooks.toTaskOutput(result, ctx);
    },
  };
}
