import { randomUUID } from "node:crypto";

import { addUsage, emptyUsage, roundCost, type AiClient, type Cost } from "@evianta/ai";
import type {
  Case,
  DocumentMetadata,
  ExtractedDocument,
  Finding,
  Task,
  TaskStatus,
  TokenUsage,
} from "@evianta/core";
import type { Store } from "@evianta/store";

import { silentLogger, type AgentLogger } from "./agent.js";
import {
  planWithCoordinatorAsync,
  type CoordinatorAgent,
  type PlanDraft,
} from "./agents/coordinator.js";
import { collectAncestors, collectDependents, topologicalOrder } from "./dag.js";
import { assembleDeliverables, deliverableIdFor } from "./deliverables.js";
import { billedUsageOf, describeTaskError, OrchestratorError } from "./errors.js";
import { createRunEventBus, createRunEventEmitter, type RunEventBus } from "./events.js";
import type { DeliverableSpec } from "./findings.js";
import type {
  TaskExecutionContext,
  TaskHandlerRegistry,
  TaskOutput,
  UpstreamSection,
} from "./handlers.js";
import { referencePlanFor } from "./plans.js";
import { activeFindings, buildTaskRecord, type PlannedSection, type TaskRecord } from "./record.js";
import { createAgentRegistry, createDefaultTaskHandlers, type AgentRegistry } from "./registry.js";
import { DEFAULT_DOCUMENT_TOKEN_BUDGET, sliceDocuments } from "./slices.js";

export const DEFAULT_CONCURRENCY = 2;

export type RunMode = "run" | "retry";

export interface OrchestratorOptions {
  store: Store;
  ai: AiClient;
  agents?: AgentRegistry;
  handlers?: TaskHandlerRegistry;
  events?: RunEventBus;
  /** Ready tasks that may run at once. Defaults to 2. */
  concurrency?: number;
  /** Token budget for document slices given to each task. */
  documentTokenBudget?: number;
  logger?: AgentLogger;
  newId?: () => string;
  now?: () => Date;
}

export interface PlanResult {
  caseId: string;
  tasks: Task[];
  /** False when the case already had a plan and nothing was created. */
  planned: boolean;
  plan?: PlanDraft;
  planningFindings: Finding[];
  usage: TokenUsage;
  costEstimate: Cost;
}

export interface RunResult {
  runId: string;
  caseId: string;
  mode: RunMode;
  status: "completed" | "failed";
  error?: string;
  plan?: Pick<PlanDraft, "source" | "issues">;
  completedTaskIds: string[];
  failedTaskIds: string[];
  blockedTaskIds: string[];
  /** Completed tasks from earlier runs that were reused, not re-run. */
  reusedTaskIds: string[];
  deliverableIds: string[];
  /** Usage and cost of this run, including planning. */
  usage: TokenUsage;
  costEstimate: Cost;
  /** Case totals across every run, including this one. */
  caseUsage: TokenUsage;
  caseCostEstimate: Cost;
}

export interface Orchestrator {
  readonly events: RunEventBus;
  readonly agents: AgentRegistry;
  readonly handlers: TaskHandlerRegistry;
  /** Plans the case with the coordinator when it has no tasks yet; otherwise returns its tasks. */
  planCaseAsync(caseId: string): Promise<PlanResult>;
  /** Plans if needed, then runs every task that is not completed. */
  runCaseAsync(caseId: string): Promise<RunResult>;
  /** Re-runs failed, blocked, and interrupted tasks plus any pending work, reusing completed work. */
  retryFailedAsync(caseId: string): Promise<RunResult>;
  isRunning(caseId: string): boolean;
}

const RETRYABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["failed", "blocked", "in-progress"]);

function toTotals(caseRecord: Case): { usage: TokenUsage; cost: Cost } {
  const input = caseRecord.usage?.inputTokens ?? 0;
  const output = caseRecord.usage?.outputTokens ?? 0;

  return {
    usage: { input, output, total: input + output },
    cost: caseRecord.usage?.costEstimate ?? 0,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const { store, ai } = options;
  const agents = options.agents ?? createAgentRegistry();
  const handlers = options.handlers ?? createDefaultTaskHandlers();
  const events = options.events ?? createRunEventBus();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const documentTokenBudget = options.documentTokenBudget ?? DEFAULT_DOCUMENT_TOKEN_BUDGET;
  const logger = options.logger ?? silentLogger;
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const activeCases = new Set<string>();

  async function getCaseOrThrowAsync(caseId: string): Promise<Case> {
    const caseRecord = await store.cases.getCaseAsync(caseId);

    if (!caseRecord) {
      throw new OrchestratorError("case-not-found", `Case "${caseId}" was not found.`);
    }

    if (!caseRecord.useCase) {
      throw new OrchestratorError("use-case-missing", `Case "${caseId}" has no use case.`);
    }

    return caseRecord;
  }

  async function loadDocumentSourcesAsync(caseId: string) {
    const metadata = await store.documents.getDocumentsForCaseAsync(caseId);
    const extractions = await Promise.all(
      metadata.map((item) => store.documents.getExtractionAsync(caseId, item.id)),
    );

    return metadata.map((item, index) => ({ metadata: item, extraction: extractions[index] }));
  }

  async function planAndPersistAsync(
    caseRecord: Case,
    chargeUsage: (usage: TokenUsage, cost: Cost) => void,
  ): Promise<PlanResult> {
    const existing = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    if (existing.length > 0) {
      return {
        caseId: caseRecord.id,
        tasks: existing,
        planned: false,
        planningFindings: [],
        usage: emptyUsage(),
        costEstimate: 0,
      };
    }

    const documents = await loadDocumentSourcesAsync(caseRecord.id);
    const planning = await planWithCoordinatorAsync({
      caseRecord,
      documents,
      ai,
      agent: agents.get("coordinator") as CoordinatorAgent | undefined,
      logger,
    });

    chargeUsage(planning.usage, planning.cost);

    const { plan } = planning;
    const idsByRole = new Map(plan.tasks.map((task) => [task.assignedRole, newId()]));
    const firstRole = plan.tasks[0]?.assignedRole;
    const questionsByRole = new Map<string, PlanDraft["openQuestions"]>();

    for (const question of plan.openQuestions) {
      const role = question.assignedRole ?? firstRole;

      if (role) {
        questionsByRole.set(role, [...(questionsByRole.get(role) ?? []), question]);
      }
    }

    const taskInputs = plan.tasks.map((draft) => {
      const questions = questionsByRole.get(draft.assignedRole) ?? [];
      const questionText = questions.map((question) => `- ${question.text}`).join("\n");
      const instructions = [
        draft.instructions,
        questionText ? `Open questions raised during planning:\n${questionText}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        id: idsByRole.get(draft.assignedRole) as string,
        caseId: caseRecord.id,
        title: draft.title,
        assignedRole: draft.assignedRole,
        ...(instructions ? { instructions } : {}),
        status: "pending" as const,
        dependsOn: draft.dependsOn.map((role) => idsByRole.get(role) as string),
        attempts: 0,
      };
    });
    const tasks = await store.tasks.createTasksAsync(caseRecord.id, taskInputs);
    const planningFindings: Finding[] = [];

    for (const task of tasks) {
      const questions = questionsByRole.get(task.assignedRole) ?? [];
      const notes = task.assignedRole === firstRole ? plan.notes : undefined;

      if (questions.length === 0 && !notes) {
        continue;
      }

      // The questions are already in the task instructions, so a failed note write is not fatal.
      try {
        planningFindings.push(
          await store.findings.addFindingAsync(caseRecord.id, {
            id: newId(),
            taskId: task.id,
            summary: "Coordinator planning notes",
            ...(notes ? { detail: notes } : {}),
            severity: "info",
            confidence: "unassessed",
            openQuestions: questions.map((question) => ({
              id: newId(),
              text: question.text,
              severity: question.severity,
            })),
          }),
        );
      } catch (error) {
        logger.warn("Could not save coordinator planning notes.", {
          caseId: caseRecord.id,
          taskId: task.id,
          error: messageOf(error),
        });
      }
    }

    if (plan.issues.length > 0) {
      logger.warn("Coordinator plan adjusted.", { caseId: caseRecord.id, issues: plan.issues });
    }

    return {
      caseId: caseRecord.id,
      tasks,
      planned: true,
      plan,
      planningFindings,
      usage: planning.usage,
      costEstimate: planning.cost,
    };
  }

  async function withCaseLockAsync<T>(caseId: string, workAsync: () => Promise<T>): Promise<T> {
    if (activeCases.has(caseId)) {
      throw new OrchestratorError(
        "run-in-progress",
        `Case "${caseId}" already has a run in progress.`,
      );
    }

    activeCases.add(caseId);

    try {
      return await workAsync();
    } finally {
      activeCases.delete(caseId);
    }
  }

  async function runLockedAsync(caseId: string, mode: RunMode): Promise<RunResult> {
    let caseRecord = await getCaseOrThrowAsync(caseId);
    let tasks = await store.tasks.getTasksForCaseAsync(caseId);

    if (mode === "retry" && !tasks.some((task) => RETRYABLE_STATUSES.has(task.status))) {
      throw new OrchestratorError(
        "nothing-to-retry",
        `Case "${caseId}" has no failed or blocked tasks to retry.`,
      );
    }

    const runId = newId();
    const emitAsync = createRunEventEmitter(store, events, caseId);
    const baseline = toTotals(caseRecord);
    let runUsage = emptyUsage();
    let runCost = 0;
    const caseTotals = () => ({
      usage: addUsage(baseline.usage, runUsage),
      cost: roundCost(baseline.cost + runCost),
    });
    const addRunUsage = (usage: TokenUsage, cost: Cost) => {
      runUsage = addUsage(runUsage, usage);
      runCost = roundCost(runCost + cost);
    };

    const completedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    const blockedTaskIds: string[] = [];
    let plan: PlanResult | undefined;
    let runError: string | undefined;
    let selectedIds: string[] = [];
    let reusedTaskIds: string[] = [];
    let deliverableIds: string[] = [];

    try {
      if (tasks.length === 0) {
        caseRecord = await store.cases.updateCaseStatusAsync(caseId, "planning");
        plan = await planAndPersistAsync(caseRecord, addRunUsage);
        tasks = plan.tasks;
      }

      // Retry also picks up pending tasks left behind when an upstream task was interrupted.
      selectedIds = tasks.filter((task) => task.status !== "completed").map((task) => task.id);
      reusedTaskIds = tasks
        .filter((task) => task.status === "completed" && !selectedIds.includes(task.id))
        .map((task) => task.id);

      await store.cases.updateCaseStatusAsync(caseId, "in-progress");
      await emitAsync({ type: "run-started", runId, mode, taskIds: selectedIds });

      for (const finding of plan?.planningFindings ?? []) {
        await emitAsync({
          type: "finding-added",
          runId,
          taskId: finding.taskId,
          findingId: finding.id,
          summary: finding.summary,
          ...(finding.severity ? { severity: finding.severity } : {}),
        });
      }

      if (plan && plan.costEstimate > 0) {
        const totals = caseTotals();

        await emitAsync({
          type: "cost-updated",
          runId,
          totalTokenUsage: totals.usage,
          totalCostEstimate: totals.cost,
        });
      }

      const orderedTasks = topologicalOrder(tasks);
      const primaryDeliverable = referencePlanFor(
        caseRecord.useCase ?? "data-analysis",
      ).deliverable;
      const documentSources = await loadDocumentSourcesAsync(caseId);
      const documentsById = new Map<string, DocumentMetadata>(
        documentSources.map((source) => [source.metadata.id, source.metadata]),
      );
      const extractionsById = new Map<string, ExtractedDocument | undefined>(
        documentSources.map((source) => [source.metadata.id, source.extraction]),
      );
      const taskById = new Map(orderedTasks.map((task) => [task.id, task]));
      const status = new Map<string, TaskStatus>(
        orderedTasks.map((task) => [task.id, task.status]),
      );
      const pending = new Set(
        orderedTasks.filter((task) => selectedIds.includes(task.id)).map((task) => task.id),
      );

      for (const id of pending) {
        status.set(id, "pending");
      }

      const currentTasks = () => orderedTasks.map((task) => taskById.get(task.id) as Task);

      const blockDependentsAsync = async (failed: Task): Promise<string[]> => {
        const blocked = [...collectDependents(orderedTasks, failed.id)].filter(
          (id) => status.get(id) !== "completed" && status.get(id) !== "blocked",
        );

        for (const id of blocked) {
          pending.delete(id);
          status.set(id, "blocked");
          blockedTaskIds.push(id);
          taskById.set(
            id,
            await store.tasks.updateTaskAsync(caseId, id, {
              status: "blocked",
              lastError: `Blocked because "${failed.title}" did not complete.`,
            }),
          );
        }

        return blocked;
      };

      const buildContextAsync = async (
        task: Task,
        attempt: number,
      ): Promise<TaskExecutionContext> => {
        const [storedFindings, deliverables] = await Promise.all([
          store.findings.getFindingsForCaseAsync(caseId),
          store.deliverables.getDeliverablesForCaseAsync(caseId),
        ]);
        const findingsByTask = new Map<string, Finding[]>();

        for (const finding of activeFindings(storedFindings, currentTasks())) {
          findingsByTask.set(finding.taskId, [
            ...(findingsByTask.get(finding.taskId) ?? []),
            finding,
          ]);
        }

        const ancestors = collectAncestors(orderedTasks, task.id);
        const upstreamTasks = currentTasks().filter((candidate) => ancestors.has(candidate.id));
        const upstreamSections: UpstreamSection[] = upstreamTasks.flatMap((upstream) =>
          deliverables.flatMap((deliverable) =>
            deliverable.sections
              .filter((section) => section.id.startsWith(`${upstream.id}-section-`))
              .map((section) => ({
                taskId: upstream.id,
                taskTitle: upstream.title,
                role: upstream.assignedRole,
                deliverableId: deliverable.id,
                title: section.title,
                content: section.editedContent ?? section.content,
              })),
          ),
        );
        const query = [task.title, task.instructions, caseRecord.description]
          .filter(Boolean)
          .join(" ");

        return {
          ai,
          case: caseRecord,
          task,
          attempt,
          tasks: currentTasks(),
          dependencies: task.dependsOn.map((id) => ({
            task: taskById.get(id) as Task,
            findings: findingsByTask.get(id) ?? [],
          })),
          upstreamFindings: upstreamTasks.flatMap(
            (upstream) => findingsByTask.get(upstream.id) ?? [],
          ),
          upstreamSections,
          documents: sliceDocuments(documentSources, { query, tokenBudget: documentTokenBudget }),
          documentMetadata: documentSources.map((source) => source.metadata),
          async loadExtractionAsync(documentId) {
            return extractionsById.has(documentId)
              ? extractionsById.get(documentId)
              : store.documents.getExtractionAsync(caseId, documentId);
          },
          agents,
          logger,
        };
      };

      // Each deliverable is rebuilt from its latest stored state so concurrent reviewer edits survive.
      const saveSectionsAsync = async (
        taskId: string,
        sections: PlannedSection[],
        specs: readonly DeliverableSpec[],
      ): Promise<void> => {
        const sectionPrefix = `${taskId}-section-`;
        const keys = new Set([
          ...sections.map((section) => section.deliverableKey),
          ...specs.map((spec) => spec.key),
        ]);

        for (const deliverable of await store.deliverables.getDeliverablesForCaseAsync(caseId)) {
          if (deliverable.sections.some((section) => section.id.startsWith(sectionPrefix))) {
            keys.add(deliverable.id.replace(/^deliverable-/, ""));
          }
        }

        for (const key of keys) {
          await store.deliverables.updateDeliverableAsync(
            caseId,
            deliverableIdFor(key),
            (current) =>
              assembleDeliverables({
                caseId,
                orderedTasks,
                existing: current ? [current] : [],
                producedByTask: new Map([
                  [taskId, sections.filter((section) => section.deliverableKey === key)],
                ]),
                primary: primaryDeliverable,
                specs: specs.filter((spec) => spec.key === key),
              })[0],
          );
        }
      };

      const persistOutputAsync = async (
        task: Task,
        output: TaskOutput,
        attempt: number,
        upstreamFindings: readonly Finding[],
      ): Promise<TaskRecord> => {
        const record = buildTaskRecord(
          output,
          {
            caseId,
            task,
            attempt,
            documentsById,
            extractionsById,
            upstreamEvidence: upstreamFindings.flatMap((finding) => finding.evidence),
            newId,
          },
          task.assignedRole,
          output.modelTier ?? agents.get(task.assignedRole)?.modelTier,
        );

        for (const dropped of record.dropped) {
          logger.warn("Dropped an evidence reference.", {
            taskId: task.id,
            reason: dropped.reason,
          });
        }

        for (const item of record.evidence) {
          await store.evidence.addEvidenceAsync(caseId, item);
        }

        for (const finding of record.findings) {
          await store.findings.addFindingAsync(caseId, finding);
        }

        await saveSectionsAsync(task.id, record.sections, output.deliverables ?? []);

        return record;
      };

      const runTaskAsync = async (initial: Task): Promise<void> => {
        const attempt = initial.attempts + 1;
        let task = initial;

        try {
          if (task.assignedRole === "independent-review") {
            await store.cases.updateCaseStatusAsync(caseId, "review");
          }

          status.set(task.id, "in-progress");
          task = await store.tasks.updateTaskAsync(caseId, task.id, {
            status: "in-progress",
            attempts: attempt,
            lastError: null,
          });
          taskById.set(task.id, task);
          await emitAsync({
            type: "task-started",
            runId,
            taskId: task.id,
            title: task.title,
            assignedRole: task.assignedRole,
            attempt,
          });
        } catch (error) {
          logger.warn("Could not start a task.", { taskId: task.id, error: messageOf(error) });
        }

        let attemptUsage = emptyUsage();
        let attemptCost = 0;
        let charged = false;
        let record: TaskRecord;
        let tokenUsage: TokenUsage;
        let costEstimate: Cost;

        try {
          const handler = handlers.get(task.assignedRole);

          if (!handler) {
            throw new Error(`No task handler is registered for role "${task.assignedRole}".`);
          }

          const context = await buildContextAsync(task, attempt);
          const output = await handler.executeAsync(context);

          attemptUsage = output.usage;
          attemptCost = output.cost;
          charged = true;
          addRunUsage(output.usage, output.cost);
          record = await persistOutputAsync(task, output, attempt, context.upstreamFindings);
          tokenUsage = addUsage(task.tokenUsage ?? emptyUsage(), attemptUsage);
          costEstimate = roundCost((task.costEstimate ?? 0) + attemptCost);
          task = await store.tasks.updateTaskAsync(caseId, task.id, {
            status: "completed",
            attempts: attempt,
            tokenUsage,
            costEstimate,
            lastError: null,
          });
          taskById.set(task.id, task);
          status.set(task.id, "completed");
          completedTaskIds.push(task.id);
        } catch (error) {
          const lastError = describeTaskError(error);
          const billed = charged ? undefined : billedUsageOf(error);

          if (billed) {
            attemptUsage = billed.usage;
            attemptCost = billed.cost;
            addRunUsage(attemptUsage, attemptCost);
          }

          logger.warn("Task failed.", { taskId: task.id, error: messageOf(error) });
          status.set(task.id, "failed");
          failedTaskIds.push(task.id);

          try {
            task = await store.tasks.updateTaskAsync(caseId, task.id, {
              status: "failed",
              attempts: attempt,
              tokenUsage: addUsage(task.tokenUsage ?? emptyUsage(), attemptUsage),
              costEstimate: roundCost((task.costEstimate ?? 0) + attemptCost),
              lastError,
            });
            taskById.set(task.id, task);

            const blocked = await blockDependentsAsync(task);

            await emitAsync({
              type: "task-failed",
              runId,
              taskId: task.id,
              error: lastError,
              blockedTaskIds: blocked,
            });

            if (attemptCost > 0) {
              const totals = caseTotals();

              await emitAsync({
                type: "cost-updated",
                runId,
                taskId: task.id,
                totalTokenUsage: totals.usage,
                totalCostEstimate: totals.cost,
              });
            }
          } catch (persistError) {
            logger.warn("Could not record a task failure.", {
              taskId: task.id,
              error: messageOf(persistError),
            });
          }

          return;
        }

        // The task is durably completed; a failed event write must not turn it into a failure.
        try {
          for (const finding of record.findings) {
            await emitAsync({
              type: "finding-added",
              runId,
              taskId: task.id,
              findingId: finding.id,
              summary: finding.summary,
              ...(finding.severity ? { severity: finding.severity } : {}),
            });
          }

          const totals = caseTotals();

          await emitAsync({
            type: "task-completed",
            runId,
            taskId: task.id,
            findingIds: record.findings.map((finding) => finding.id),
            tokenUsage,
            costEstimate,
            runningCostEstimate: totals.cost,
          });
          await emitAsync({
            type: "cost-updated",
            runId,
            taskId: task.id,
            totalTokenUsage: totals.usage,
            totalCostEstimate: totals.cost,
          });
        } catch (error) {
          logger.warn("Could not publish task completion.", {
            taskId: task.id,
            error: messageOf(error),
          });
        }
      };

      const inFlight = new Map<string, Promise<void>>();

      while (pending.size > 0 || inFlight.size > 0) {
        for (const id of [...pending]) {
          if (inFlight.size >= concurrency) {
            break;
          }

          const task = taskById.get(id) as Task;

          if (task.dependsOn.every((dependency) => status.get(dependency) === "completed")) {
            pending.delete(id);
            inFlight.set(
              id,
              runTaskAsync(task).finally(() => {
                inFlight.delete(id);
              }),
            );
          }
        }

        if (inFlight.size === 0) {
          for (const id of [...pending]) {
            pending.delete(id);
            status.set(id, "blocked");
            blockedTaskIds.push(id);
            taskById.set(
              id,
              await store.tasks.updateTaskAsync(caseId, id, {
                status: "blocked",
                lastError: "Blocked because a task it depends on has not completed.",
              }),
            );
          }

          break;
        }

        await Promise.race(inFlight.values());
      }

      deliverableIds = (await store.deliverables.getDeliverablesForCaseAsync(caseId)).map(
        (deliverable) => deliverable.id,
      );

      if (failedTaskIds.length > 0 || blockedTaskIds.length > 0) {
        const failedTitles = failedTaskIds.map((id) => `"${taskById.get(id)?.title ?? id}"`);

        runError =
          failedTaskIds.length > 0
            ? `${failedTaskIds.length} task(s) failed: ${failedTitles.join(", ")}.`
            : `${blockedTaskIds.length} task(s) could not run.`;
      }
    } catch (error) {
      runError = messageOf(error);
      logger.warn("Run failed.", { caseId, runId, error: runError });
    }

    const totals = caseTotals();
    const finishedAt = now().toISOString();
    const recordingErrors: string[] = [];
    const recordAsync = async (step: string, workAsync: () => Promise<unknown>) => {
      try {
        await workAsync();
      } catch (error) {
        recordingErrors.push(`${step}: ${messageOf(error)}`);
        logger.warn("Could not record the end of the run.", {
          caseId,
          runId,
          step,
          error: messageOf(error),
        });
      }
    };

    const finalError = () =>
      [runError, ...recordingErrors.map((message) => `Could not record ${message}.`)]
        .filter(Boolean)
        .join(" ") || undefined;

    await recordAsync("case usage", () =>
      store.cases.updateCaseUsageAsync(caseId, {
        inputTokens: runUsage.input,
        outputTokens: runUsage.output,
        costEstimate: runCost,
        runCount: 1,
        lastRunAt: finishedAt,
      }),
    );
    await recordAsync("case status", () =>
      store.cases.updateCaseStatusAsync(caseId, finalError() ? "failed" : "completed"),
    );

    const statusError = finalError();

    await recordAsync("the terminal event", () =>
      emitAsync(
        statusError
          ? {
              type: "run-failed",
              runId,
              error: statusError,
              failedTaskIds,
              totalTokenUsage: totals.usage,
              totalCostEstimate: totals.cost,
              timestamp: finishedAt,
            }
          : {
              type: "run-completed",
              runId,
              deliverableIds,
              totalTokenUsage: totals.usage,
              totalCostEstimate: totals.cost,
              timestamp: finishedAt,
            },
      ),
    );

    const error = finalError();

    return {
      runId,
      caseId,
      mode,
      status: error ? "failed" : "completed",
      ...(error ? { error } : {}),
      ...(plan?.plan ? { plan: { source: plan.plan.source, issues: plan.plan.issues } } : {}),
      completedTaskIds,
      failedTaskIds,
      blockedTaskIds,
      reusedTaskIds,
      deliverableIds,
      usage: runUsage,
      costEstimate: runCost,
      caseUsage: totals.usage,
      caseCostEstimate: totals.cost,
    };
  }

  return {
    events,
    agents,
    handlers,
    async planCaseAsync(caseId) {
      return withCaseLockAsync(caseId, async () => {
        const caseRecord = await getCaseOrThrowAsync(caseId);
        let usage = emptyUsage();
        let cost = 0;

        try {
          return await planAndPersistAsync(caseRecord, (planningUsage, planningCost) => {
            usage = addUsage(usage, planningUsage);
            cost = roundCost(cost + planningCost);
          });
        } finally {
          if (usage.total > 0 || cost > 0) {
            await store.cases.updateCaseUsageAsync(caseId, {
              inputTokens: usage.input,
              outputTokens: usage.output,
              costEstimate: cost,
            });
          }
        }
      });
    },
    runCaseAsync(caseId) {
      return withCaseLockAsync(caseId, () => runLockedAsync(caseId, "run"));
    },
    retryFailedAsync(caseId) {
      return withCaseLockAsync(caseId, () => runLockedAsync(caseId, "retry"));
    },
    isRunning(caseId) {
      return activeCases.has(caseId);
    },
  };
}
