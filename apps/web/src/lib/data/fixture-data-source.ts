import {
  isTerminalRunEvent,
  type AskResponse,
  type Case,
  type CaseDocument,
  type CaseState,
  type CaseUsage,
  type ExtractionMethod,
  type OpenQuestion,
  type RunEvent,
  type Task,
  type UsageSummary,
  type UsageTotals,
} from "@evianta/core";
import {
  fixtureFailure,
  getSampleStateForUseCase,
  sampleCaseStates,
  sampleRunEvents,
  toUsageRow,
} from "@/fixtures";
import { buildRunEvents, collectDependents, toFailedCaseState } from "@/fixtures/run-events";
import { ApiError, SampleReadOnlyError } from "@/lib/api/errors";
import { getVisitorId } from "@/lib/visitor";
import type { CaseDataSource, RunStreamHandlers, RunStreamOptions } from "./types";

export interface FixtureDataSourceOptions {
  replayIntervalMs?: number;
  getVisitorId?: () => string;
  now?: () => Date;
  // Extra case states to seed, for example the failed-run fixture in tests.
  seedStates?: CaseState[];
  seedEvents?: Record<string, RunEvent[]>;
}

interface PendingRun {
  runId: string;
  events: RunEvent[];
  finalState: CaseState;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function rekeyState(state: CaseState, caseId: string): CaseState {
  const copy = clone(state);
  return {
    ...copy,
    case: { ...copy.case, id: caseId },
    tasks: copy.tasks.map((task) => ({ ...task, caseId })),
    deliverables: copy.deliverables.map((deliverable) => ({ ...deliverable, caseId })),
    documents: copy.documents.map((document) => ({ ...document, caseId })),
  };
}

function guessMethod(file: File): ExtractionMethod {
  const name = file.name.toLowerCase();
  if (/\.(csv|tsv|xlsx?)$/.test(name)) {
    return "parse";
  }

  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(name)) {
    return "ocr";
  }

  return "pdf-text";
}

function sumTaskUsage(tasks: Task[]): { input: number; output: number; cost: number } {
  return tasks.reduce(
    (total, task) => ({
      input: total.input + (task.tokenUsage?.input ?? 0),
      output: total.output + (task.tokenUsage?.output ?? 0),
      cost: total.cost + (task.costEstimate ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );
}

function addToUsage(
  previous: CaseUsage | undefined,
  tasks: Task[],
  lastRunAt: string,
  countRun: boolean,
): CaseUsage {
  const added = sumTaskUsage(tasks);
  return {
    inputTokens: (previous?.inputTokens ?? 0) + added.input,
    outputTokens: (previous?.outputTokens ?? 0) + added.output,
    costEstimate: Math.round(((previous?.costEstimate ?? 0) + added.cost) * 1_000_000) / 1_000_000,
    runCount: (previous?.runCount ?? 0) + (countRun ? 1 : 0),
    lastRunAt,
  };
}

function totalsFor(states: CaseState[]): UsageTotals {
  const rows = states.map(toUsageRow);
  return {
    cases: rows.length,
    runs: rows.reduce((total, row) => total + row.runCount, 0),
    visitors: new Set(rows.map((row) => row.visitorId).filter(Boolean)).size,
    tokens: rows.reduce((total, row) => total + row.tokenUsage.total, 0),
    costEstimate: rows.reduce((total, row) => total + row.costEstimate, 0),
  };
}

export function createFixtureDataSource(options: FixtureDataSourceOptions = {}): CaseDataSource {
  const replayIntervalMs = options.replayIntervalMs ?? 450;
  const now = options.now ?? (() => new Date());
  const visitorId = options.getVisitorId ?? (() => getVisitorId());
  const states = new Map<string, CaseState>();
  const recordedEvents = new Map<string, RunEvent[]>();
  const pendingRuns = new Map<string, PendingRun>();
  const failedOnce = new Set<string>();

  for (const state of [...sampleCaseStates, ...(options.seedStates ?? [])]) {
    states.set(state.case.id, clone(state));
  }

  for (const [caseId, events] of Object.entries({ ...sampleRunEvents, ...options.seedEvents })) {
    recordedEvents.set(caseId, clone(events));
  }

  function wait<T>(value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), 0));
  }

  function requireState(caseId: string): CaseState {
    const state = states.get(caseId);
    if (!state) {
      throw new ApiError("This case could not be found.", 404, { reason: "not-found" });
    }

    return state;
  }

  function requireEditable(caseId: string): CaseState {
    const state = requireState(caseId);
    if (state.case.isSample) {
      throw new SampleReadOnlyError(`/cases/${encodeURIComponent(caseId)}/copy`);
    }

    return state;
  }

  function lastSeqFor(caseId: string): number {
    const events = recordedEvents.get(caseId) ?? [];
    return events.at(-1)?.seq ?? 0;
  }

  function touch(state: CaseState, update: Partial<Case>): CaseState {
    return { ...state, case: { ...state.case, ...update, updatedAt: now().toISOString() } };
  }

  function finalizeRun(caseId: string) {
    const pending = pendingRuns.get(caseId);
    if (!pending) {
      return;
    }

    pendingRuns.delete(caseId);
    states.set(caseId, pending.finalState);
    recordedEvents.set(caseId, [...(recordedEvents.get(caseId) ?? []), ...pending.events]);
  }

  function findQuestion(state: CaseState, questionId: string): OpenQuestion {
    for (const finding of state.findings) {
      const question = finding.openQuestions.find((candidate) => candidate.id === questionId);
      if (question) {
        return question;
      }
    }

    throw new ApiError("This open question could not be found.", 404, { reason: "not-found" });
  }

  function updateQuestion(
    caseId: string,
    questionId: string,
    status: OpenQuestion["status"],
    note: string | undefined,
  ): OpenQuestion {
    const state = requireEditable(caseId);
    findQuestion(state, questionId);
    const resolvedAt = now().toISOString();
    const next: CaseState = {
      ...state,
      findings: state.findings.map((finding) => ({
        ...finding,
        openQuestions: finding.openQuestions.map((question) =>
          question.id === questionId
            ? { ...question, status, resolutionNote: note, resolvedAt }
            : question,
        ),
      })),
    };
    states.set(caseId, next);
    return clone(findQuestion(next, questionId));
  }

  return {
    mode: "fixtures",

    async listAgentsAsync() {
      return wait({ roles: [], agents: [] });
    },

    async getAgentAsync() {
      throw new ApiError("The specialist directory needs the live API.", 404);
    },

    async listSamplesAsync() {
      return wait(
        [...states.values()]
          .filter((state) => state.case.isSample)
          .map((state) => clone(state.case)),
      );
    },

    async listCasesAsync() {
      const id = visitorId();
      return wait(
        [...states.values()]
          .filter((state) => !state.case.isSample && state.case.visitorId === id)
          .map((state) => clone(state.case))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    },

    async createCaseAsync(request) {
      const createdAt = now().toISOString();
      const created: Case = {
        id: createId("case"),
        title: request.title.trim(),
        description: request.description?.trim() || undefined,
        useCase: request.useCase,
        status: "draft",
        visitorId: visitorId(),
        isSample: false,
        createdAt,
        updatedAt: createdAt,
      };
      states.set(created.id, {
        case: created,
        tasks: [],
        findings: [],
        evidence: [],
        deliverables: [],
        documents: [],
      });
      return wait(clone(created));
    },

    async copyCaseAsync(caseId) {
      const source = requireState(caseId);
      const copyId = createId("case");
      const createdAt = now().toISOString();
      const copy = rekeyState(source, copyId);
      copy.case = {
        ...copy.case,
        isSample: false,
        sourceCaseId: source.case.id,
        visitorId: visitorId(),
        createdAt,
        updatedAt: createdAt,
      };
      states.set(copyId, copy);
      const events = recordedEvents.get(caseId);
      if (events) {
        recordedEvents.set(
          copyId,
          events.map((event) => ({ ...event, caseId: copyId })),
        );
      }

      return wait(clone(copy.case));
    },

    async getCaseStateAsync(caseId) {
      return wait(clone(requireState(caseId)));
    },

    async uploadDocumentAsync(caseId, file) {
      const state = requireEditable(caseId);
      const id = createId("doc");
      const method = guessMethod(file);
      const document: CaseDocument = {
        id,
        caseId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        gcsPath: `cases/${caseId}/documents/${id}`,
        uploadedAt: now().toISOString(),
        processing: {
          status: "ready",
          method,
          confidence: method === "parse" ? 1 : 0.9,
          handwritingDetected: false,
          warnings: [],
        },
      };
      states.set(caseId, { ...touch(state, {}), documents: [...state.documents, document] });
      await new Promise((resolve) => setTimeout(resolve, replayIntervalMs));
      return clone(document);
    },

    async startRunAsync(caseId) {
      const state = requireEditable(caseId);
      if (pendingRuns.has(caseId)) {
        return { runId: pendingRuns.get(caseId)?.runId ?? "" };
      }

      const useCase = state.case.useCase ?? "data-analysis";
      const template = rekeyState(getSampleStateForUseCase(useCase), caseId);
      const planned: CaseState = {
        ...template,
        case: state.case,
        documents: state.documents,
      };
      const runId = createId("run");
      const startedAt = now().toISOString();
      const lastSeq = lastSeqFor(caseId);
      const previousUsage = state.case.usage;
      const shouldFail = useCase === fixtureFailure.useCase && !failedOnce.has(caseId);
      const eventOptions = {
        runId,
        startSeq: lastSeq + 1,
        startTime: startedAt,
        stepMs: 900,
        initialUsage: {
          input: previousUsage?.inputTokens ?? 0,
          output: previousUsage?.outputTokens ?? 0,
          total: (previousUsage?.inputTokens ?? 0) + (previousUsage?.outputTokens ?? 0),
        },
        initialCost: previousUsage?.costEstimate ?? 0,
      };
      let events: RunEvent[];
      let finalState: CaseState;
      if (shouldFail) {
        failedOnce.add(caseId);
        events = buildRunEvents(planned, {
          ...eventOptions,
          failTaskId: fixtureFailure.taskId,
          failError: fixtureFailure.error,
        });
        const failed = toFailedCaseState(planned, {
          runId,
          failTaskId: fixtureFailure.taskId,
          failError: fixtureFailure.error,
          lastEventSeq: events.at(-1)?.seq ?? lastSeq,
        });
        const completedTasks = failed.tasks.filter((task) => task.status === "completed");
        finalState = {
          ...failed,
          case: {
            ...failed.case,
            usage: addToUsage(previousUsage, completedTasks, startedAt, true),
          },
          latestRun: failed.latestRun && { ...failed.latestRun, startedAt, finishedAt: startedAt },
        };
      } else {
        events = buildRunEvents(planned, eventOptions);
        finalState = {
          ...planned,
          case: {
            ...planned.case,
            status: "completed",
            usage: addToUsage(previousUsage, planned.tasks, startedAt, true),
          },
          latestRun: {
            runId,
            mode: "run",
            status: "completed",
            startedAt,
            finishedAt: startedAt,
            lastEventSeq: events.at(-1)?.seq ?? lastSeq,
          },
        };
      }

      pendingRuns.set(caseId, { runId, events, finalState });
      states.set(caseId, {
        ...touch(state, { status: "in-progress" }),
        tasks: planned.tasks.map((task) => ({
          ...task,
          status: "pending",
          attempts: 0,
          lastError: undefined,
          tokenUsage: undefined,
          costEstimate: undefined,
        })),
        findings: [],
        deliverables: [],
        latestRun: { runId, mode: "run", status: "running", startedAt, lastEventSeq: lastSeq },
      });
      return wait({ runId });
    },

    async retryRunAsync(caseId) {
      const state = requireEditable(caseId);
      const failedIds = state.tasks
        .filter((task) => task.status === "failed")
        .map((task) => task.id);
      if (failedIds.length === 0) {
        throw new ApiError("There are no failed steps to retry.", 409, {
          reason: "nothing-to-retry",
        });
      }

      const retryIds = new Set(failedIds);
      for (const failedId of failedIds) {
        for (const dependent of collectDependents(state.tasks, failedId)) {
          retryIds.add(dependent);
        }
      }

      const useCase = state.case.useCase ?? "data-analysis";
      const template = rekeyState(getSampleStateForUseCase(useCase), caseId);
      const runId = createId("run");
      const startedAt = now().toISOString();
      const lastSeq = lastSeqFor(caseId);
      const usage = state.case.usage;
      const completeState: CaseState = {
        ...template,
        case: state.case,
        documents: state.documents,
        tasks: template.tasks.map((task) =>
          retryIds.has(task.id)
            ? { ...task, attempts: (state.tasks.find((t) => t.id === task.id)?.attempts ?? 0) + 1 }
            : (state.tasks.find((t) => t.id === task.id) ?? task),
        ),
      };
      const events = buildRunEvents(completeState, {
        runId,
        mode: "retry",
        taskIds: [...retryIds],
        startSeq: lastSeq + 1,
        startTime: startedAt,
        stepMs: 900,
        initialUsage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
        },
        initialCost: usage?.costEstimate ?? 0,
      });
      const retriedTasks = completeState.tasks.filter((task) => retryIds.has(task.id));
      pendingRuns.set(caseId, {
        runId,
        events,
        finalState: {
          ...completeState,
          case: {
            ...completeState.case,
            status: "completed",
            usage: addToUsage(usage, retriedTasks, startedAt, true),
          },
          latestRun: {
            runId,
            mode: "retry",
            status: "completed",
            startedAt,
            finishedAt: startedAt,
            lastEventSeq: events.at(-1)?.seq ?? lastSeq,
          },
        },
      });
      states.set(caseId, {
        ...touch(state, { status: "in-progress" }),
        latestRun: { runId, mode: "retry", status: "running", startedAt, lastEventSeq: lastSeq },
      });
      return wait({ runId });
    },

    subscribeToRun(
      caseId: string,
      handlers: RunStreamHandlers,
      streamOptions: RunStreamOptions = {},
    ) {
      const pending = pendingRuns.get(caseId);
      const isPending = Boolean(
        pending && (!streamOptions.runId || pending.runId === streamOptions.runId),
      );
      const runId =
        streamOptions.runId ?? (isPending ? pending?.runId : states.get(caseId)?.latestRun?.runId);
      const source = isPending && pending ? pending.events : (recordedEvents.get(caseId) ?? []);
      const queue = source.filter(
        (event) =>
          (!runId || event.runId === runId) && event.seq > (streamOptions.lastEventId ?? 0),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;

      function emitNext() {
        const event = queue.shift();
        if (closed || !event) {
          return;
        }

        handlers.onEvent(clone(event));
        if (isTerminalRunEvent(event)) {
          closed = true;
          if (isPending) {
            finalizeRun(caseId);
          }

          handlers.onConnectionChange?.("closed");
          handlers.onTerminal?.(event);
          return;
        }

        timer = setTimeout(emitNext, replayIntervalMs);
      }

      handlers.onConnectionChange?.("open");
      timer = setTimeout(emitNext, replayIntervalMs);
      return () => {
        closed = true;
        if (timer) {
          clearTimeout(timer);
        }

        if (isPending) {
          finalizeRun(caseId);
        }
      };
    },

    async getDeliverableAsync(caseId, deliverableId) {
      const deliverable = requireState(caseId).deliverables.find(
        (candidate) => candidate.id === deliverableId,
      );
      if (!deliverable) {
        throw new ApiError("This deliverable could not be found.", 404, { reason: "not-found" });
      }

      return wait(clone(deliverable));
    },

    getExportUrl() {
      return undefined;
    },

    async askAsync(caseId, question): Promise<AskResponse> {
      const state = requireState(caseId);
      const words = question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3);
      const matches = state.findings.filter((finding) =>
        words.some((word) =>
          `${finding.summary} ${finding.detail ?? ""}`.toLowerCase().includes(word),
        ),
      );
      if (matches.length === 0) {
        return wait({
          answer: "The sample work record does not cover this question.",
          supported: false,
          findingIds: [],
          evidenceIds: [],
        });
      }

      return wait({
        answer: matches.map((finding) => finding.summary).join(" "),
        supported: true,
        findingIds: matches.map((finding) => finding.id),
        evidenceIds: matches.flatMap((finding) => finding.evidence.map((evidence) => evidence.id)),
      });
    },

    async updateSectionAsync(caseId, deliverableId, sectionId, update) {
      const state = requireEditable(caseId);
      const reviewedAt = now().toISOString();
      let updated: CaseState["deliverables"][number]["sections"][number] | undefined;
      const deliverables = state.deliverables.map((deliverable) =>
        deliverable.id !== deliverableId
          ? deliverable
          : {
              ...deliverable,
              sections: deliverable.sections.map((section) => {
                if (section.id !== sectionId) {
                  return section;
                }

                updated = {
                  ...section,
                  ...(update.editedContent !== undefined
                    ? { editedContent: update.editedContent, editedAt: reviewedAt }
                    : {}),
                  ...(update.reviewStatus ? { reviewStatus: update.reviewStatus, reviewedAt } : {}),
                  ...(update.reviewComment !== undefined
                    ? { reviewComment: update.reviewComment }
                    : {}),
                };
                return updated;
              }),
            },
      );
      if (!updated) {
        throw new ApiError("This section could not be found.", 404, { reason: "not-found" });
      }

      states.set(caseId, { ...state, deliverables });
      return wait(clone(updated));
    },

    async resolveOpenQuestionAsync(caseId, questionId, note) {
      return wait(updateQuestion(caseId, questionId, "resolved", note));
    },

    async dismissOpenQuestionAsync(caseId, questionId, note) {
      return wait(updateQuestion(caseId, questionId, "dismissed", note));
    },

    async approveCaseAsync(caseId, note) {
      const state = requireEditable(caseId);
      const unresolvedQuestionIds = state.findings.flatMap((finding) =>
        finding.openQuestions
          .filter((question) => question.status === "open")
          .map((question) => question.id),
      );
      const next = touch(state, {
        status: "completed",
        approval: { approvedAt: now().toISOString(), unresolvedQuestionIds, note },
      });
      states.set(caseId, next);
      return wait(clone(next.case));
    },

    async listUsageCasesAsync() {
      const rows = [...states.values()]
        .map(toUsageRow)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return wait({ cases: rows });
    },

    async getUsageSummaryAsync(): Promise<UsageSummary> {
      const all = [...states.values()];
      const byUseCase = (["data-analysis", "tax-notice", "msme-payment"] as const).map(
        (useCase) => ({
          useCase,
          ...totalsFor(all.filter((state) => state.case.useCase === useCase)),
        }),
      );
      return wait({ totals: totalsFor(all), byUseCase });
    },
  };
}
