import {
  apiErrorCodes,
  createCaseIntake,
  isTerminalRunEvent,
  type AskResult,
  type Case,
  type CaseDocument,
  type CaseState,
  type CaseUsage,
  type ExtractionMethod,
  type Finding,
  type RunEvent,
  type RunMode,
  type RunStartResponse,
  type Task,
  type UsageCaseRow,
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
import { findCannedAnswer } from "@/fixtures/ask";
import { extractionSummary } from "@/fixtures/documents";
import { getFixtureAssetUrl, getFixtureExtraction } from "@/fixtures/extractions";
import { buildRunEvents, collectDependents, toFailedCaseState } from "@/fixtures/run-events";
import { ApiError, SampleReadOnlyError } from "@/lib/api/errors";
import { applyQuestionUpdate, applySectionUpdate } from "@/lib/review";
import { getVisitorId } from "@/lib/visitor";
import { createFixtureChat } from "./fixture-chat";
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
  if (/\.(csv|tsv|xlsx?|jsonl?|ndjson|txt|md|markdown|docx)$/.test(name)) {
    return "parse";
  }

  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(name)) {
    return "ocr";
  }

  return "pdf-text";
}

function isTextDocumentFile(file: File): boolean {
  return /\.(txt|md|markdown|docx)$/.test(file.name.toLowerCase());
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

export const caseAlreadyPlannedMessage =
  "Documents cannot be added after the case has been planned. Start a new case to use different documents.";

function startResponse(caseId: string, runId: string, mode: RunMode): RunStartResponse {
  return { caseId, runId, mode, streamUrl: `/cases/${encodeURIComponent(caseId)}/stream` };
}

function addTotals(totals: UsageTotals, row: UsageCaseRow): UsageTotals {
  return {
    cases: totals.cases + 1,
    samples: totals.samples + (row.isSample ? 1 : 0),
    copies: totals.copies + (row.isCopy ? 1 : 0),
    runs: totals.runs + row.runCount,
    visitors: totals.visitors,
    tokenUsage: {
      input: totals.tokenUsage.input + row.tokenUsage.input,
      output: totals.tokenUsage.output + row.tokenUsage.output,
      total: totals.tokenUsage.total + row.tokenUsage.total,
    },
    costEstimate: totals.costEstimate + row.costEstimate,
  };
}

function totalsFor(states: CaseState[]): UsageTotals {
  const rows = states.map(toUsageRow);
  const empty: UsageTotals = {
    cases: 0,
    samples: 0,
    copies: 0,
    runs: 0,
    visitors: new Set(rows.map((row) => row.visitorId).filter(Boolean)).size,
    tokenUsage: { input: 0, output: 0, total: 0 },
    costEstimate: 0,
  };
  return rows.reduce(addTotals, empty);
}

export function createFixtureDataSource(options: FixtureDataSourceOptions = {}): CaseDataSource {
  const replayIntervalMs = options.replayIntervalMs ?? 450;
  const now = options.now ?? (() => new Date());
  const visitorId = options.getVisitorId ?? (() => getVisitorId());
  const states = new Map<string, CaseState>();
  const recordedEvents = new Map<string, RunEvent[]>();
  const pendingRuns = new Map<string, PendingRun>();
  const failedOnce = new Set<string>();
  const uploadsInFlight = new Map<string, number>();
  const uploadedFileUrls = new Map<string, string>();

  function requireNoUploads(caseId: string) {
    if ((uploadsInFlight.get(caseId) ?? 0) > 0) {
      throw new ApiError("Wait for the upload to finish before running.", 409, {
        code: apiErrorCodes.uploadInProgress,
      });
    }
  }

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
      throw new ApiError("This case could not be found.", 404, { code: "not-found" });
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
    // Intake and details may change while the run is replaying; keep the latest intake.
    const current = states.get(caseId)?.case;
    states.set(caseId, {
      ...pending.finalState,
      case: {
        ...pending.finalState.case,
        intake: current?.intake ?? pending.finalState.case.intake,
      },
    });
    recordedEvents.set(caseId, [...(recordedEvents.get(caseId) ?? []), ...pending.events]);
  }

  function findQuestionFinding(state: CaseState, questionId: string): Finding {
    const finding = state.findings.find((candidate) =>
      candidate.openQuestions.some((question) => question.id === questionId),
    );
    if (finding) {
      return finding;
    }

    throw new ApiError("This open question could not be found.", 404, { code: "not-found" });
  }

  function updateQuestion(
    caseId: string,
    questionId: string,
    status: "resolved" | "dismissed",
    note: string | undefined,
  ): Finding {
    const state = requireEditable(caseId);
    findQuestionFinding(state, questionId);
    const resolvedAt = now().toISOString();
    const next: CaseState = {
      ...state,
      findings: state.findings.map((finding) =>
        applyQuestionUpdate(finding, questionId, status, note, resolvedAt),
      ),
    };
    states.set(caseId, next);
    return clone(findQuestionFinding(next, questionId));
  }

  const chat = createFixtureChat({
    now,
    visitorId,
    createId,
    replayIntervalMs,
    getState: requireState,
    getEditableState: requireEditable,
    setState: (caseId, state) => states.set(caseId, state),
    isRunActive: (caseId) => pendingRuns.has(caseId),
    askAsync: (caseId, question, askOptions) => dataSource.askAsync(caseId, question, askOptions),
  });
  const { recordRunMessage, ...chatMethods } = chat;

  const dataSource: CaseDataSource = {
    mode: "fixtures",
    ...chatMethods,

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
        intake: createCaseIntake(request.intakeMode ?? "form"),
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
        run: { active: false, lastEventSeq: 0 },
      });
      return wait(clone(created));
    },

    async copyCaseAsync(caseId) {
      const source = requireState(caseId);
      const copyId = createId("case");
      const createdAt = now().toISOString();
      const copy = rekeyState(source, copyId);
      // Mirrors buildCaseCopy in @evianta/store: a copy starts without usage or sign-off.
      copy.case = {
        ...copy.case,
        isSample: false,
        sourceCaseId: source.case.id,
        visitorId: visitorId(),
        usage: undefined,
        approval: undefined,
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

    async getDocumentAsync(caseId, documentId) {
      const document = requireState(caseId).documents.find(
        (candidate) => candidate.id === documentId,
      );
      if (!document) {
        throw new ApiError("This document could not be found.", 404, { code: "not-found" });
      }

      const extraction = getFixtureExtraction(documentId);
      return wait(clone({ document, ...(extraction ? { extraction } : {}) }));
    },

    getDocumentFileUrl(_caseId, documentId) {
      return uploadedFileUrls.get(documentId) ?? getFixtureAssetUrl(documentId);
    },

    async uploadDocumentAsync(caseId, file) {
      const state = requireEditable(caseId);
      if (pendingRuns.has(caseId)) {
        throw new ApiError("Wait for the run to finish before uploading.", 409, {
          code: apiErrorCodes.runInProgress,
        });
      }

      if (state.tasks.length > 0) {
        throw new ApiError(caseAlreadyPlannedMessage, 409, {
          code: apiErrorCodes.caseAlreadyPlanned,
        });
      }

      const id = createId("doc");
      const method = guessMethod(file);
      const document: CaseDocument = {
        id,
        caseId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        uploadedAt: now().toISOString(),
        status: "ready",
        extraction: extractionSummary(
          method,
          method === "parse" ? 1 : 0.9,
          isTextDocumentFile(file) ? { kind: "text", pageCount: 1, tableCount: 0 } : {},
        ),
      };
      uploadsInFlight.set(caseId, (uploadsInFlight.get(caseId) ?? 0) + 1);
      try {
        await new Promise((resolve) => setTimeout(resolve, replayIntervalMs));
        const current = requireState(caseId);
        states.set(caseId, {
          ...touch(current, {}),
          documents: [...current.documents, document],
        });
        if (typeof URL.createObjectURL === "function") {
          uploadedFileUrls.set(id, URL.createObjectURL(file));
        }
      } finally {
        uploadsInFlight.set(caseId, (uploadsInFlight.get(caseId) ?? 1) - 1);
      }

      return clone(document);
    },

    async startRunAsync(caseId) {
      const state = requireEditable(caseId);
      requireNoUploads(caseId);
      if (pendingRuns.has(caseId)) {
        return startResponse(caseId, pendingRuns.get(caseId)?.runId ?? "", "run");
      }

      const useCase = state.case.useCase;
      if (!useCase) {
        throw new ApiError("Choose the kind of work before starting.", 422, {
          code: apiErrorCodes.useCaseMissing,
        });
      }

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
          run: {
            active: false,
            lastEventSeq: events.at(-1)?.seq ?? lastSeq,
            lastRunId: runId,
            lastEventType: "run-completed",
            lastRunMode: "run",
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
        run: { ...state.run, active: true, lastEventSeq: lastSeq },
      });
      recordRunMessage(caseId, runId, "run");
      return wait(startResponse(caseId, runId, "run"));
    },

    async retryRunAsync(caseId) {
      const state = requireEditable(caseId);
      requireNoUploads(caseId);
      const failedIds = state.tasks
        .filter((task) => task.status === "failed")
        .map((task) => task.id);
      if (failedIds.length === 0) {
        throw new ApiError("There are no failed steps to retry.", 409, {
          code: "nothing-to-retry",
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
          run: {
            active: false,
            lastEventSeq: events.at(-1)?.seq ?? lastSeq,
            lastRunId: runId,
            lastEventType: "run-completed",
            lastRunMode: "retry",
          },
        },
      });
      states.set(caseId, {
        ...touch(state, { status: "in-progress" }),
        run: { ...state.run, active: true, lastEventSeq: lastSeq },
      });
      recordRunMessage(caseId, runId, "retry");
      return wait(startResponse(caseId, runId, "retry"));
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
        streamOptions.runId ?? (isPending ? pending?.runId : states.get(caseId)?.run.lastRunId);
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
        throw new ApiError("This deliverable could not be found.", 404, { code: "not-found" });
      }

      return wait(clone(deliverable));
    },

    getExportUrl() {
      return undefined;
    },

    async askAsync(caseId, question, askOptions = {}): Promise<AskResult> {
      const state = requireState(caseId);
      const canned = state.case.useCase
        ? findCannedAnswer(state.case.useCase, question)
        : undefined;
      const findingsById = new Map(state.findings.map((finding) => [finding.id, finding]));
      const evidenceById = new Map(
        [...state.evidence, ...state.findings.flatMap((finding) => finding.evidence)].map(
          (evidence) => [evidence.id, evidence],
        ),
      );

      async function streamAsync(text: string) {
        const delayMs = Math.min(35, replayIntervalMs / 12);
        const chunks = delayMs > 0 ? (text.match(/\S+\s*/g) ?? [text]) : [text];
        for (const chunk of chunks) {
          if (askOptions.signal?.aborted) {
            throw new DOMException("The question was cancelled.", "AbortError");
          }

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          askOptions.onDelta?.(chunk);
        }
      }

      let answer: string | undefined;
      let findingIds: string[] = [];
      let evidenceIds: string[] = [];
      if (canned && canned.findingIds.every((id) => findingsById.has(id))) {
        answer = canned.answer;
        findingIds = canned.findingIds;
        evidenceIds = canned.evidenceIds.filter((id) => evidenceById.has(id));
      } else {
        const words = question
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 3);
        const matches = state.findings.filter((finding) =>
          words.some((word) =>
            `${finding.summary} ${finding.detail ?? ""}`.toLowerCase().includes(word),
          ),
        );
        if (matches.length > 0) {
          answer = matches.map((finding) => finding.summary).join(". ");
          findingIds = matches.map((finding) => finding.id);
          evidenceIds = matches.flatMap((finding) =>
            finding.evidence.map((evidence) => evidence.id),
          );
        }
      }

      if (!answer) {
        const message =
          "The recorded work record for this sample does not cover this question, so there is no grounded answer.";
        await streamAsync(message);
        return {
          status: "not-supported",
          message,
          evidenceIds: [],
          findingIds: [],
          canFlagForReview: true,
          retrievedFindingIds: [],
        };
      }

      await streamAsync(answer);
      return clone({
        status: "answered" as const,
        answer,
        findingIds,
        evidenceIds: [...new Set(evidenceIds)],
        evidence: [...new Set(evidenceIds)]
          .map((id) => evidenceById.get(id))
          .filter((evidence) => evidence !== undefined),
        retrievedFindingIds: findingIds,
      });
    },

    async updateSectionAsync(caseId, deliverableId, sectionId, update) {
      const state = requireEditable(caseId);
      const reviewedAt = now().toISOString();
      let found = false;
      const deliverables = state.deliverables.map((deliverable) =>
        deliverable.id !== deliverableId
          ? deliverable
          : {
              ...deliverable,
              sections: deliverable.sections.map((section) => {
                if (section.id !== sectionId) {
                  return section;
                }

                found = true;
                return applySectionUpdate(section, update, reviewedAt);
              }),
            },
      );
      const updated = deliverables.find((deliverable) => deliverable.id === deliverableId);
      if (!found || !updated) {
        throw new ApiError("This section could not be found.", 404, { code: "not-found" });
      }

      const next = { ...state, deliverables };
      states.set(
        caseId,
        update.editedContent !== undefined ? touch(next, { approval: undefined }) : next,
      );
      return wait(clone(updated));
    },

    async resolveOpenQuestionAsync(caseId, questionId, note) {
      return wait(updateQuestion(caseId, questionId, "resolved", note));
    },

    async dismissOpenQuestionAsync(caseId, questionId, note) {
      return wait(updateQuestion(caseId, questionId, "dismissed", note));
    },

    async approveCaseAsync(caseId, note, acknowledgeIncompleteReview) {
      const state = requireEditable(caseId);
      const incompleteReview = state.tasks.some(
        (task) => task.assignedRole === "independent-review" && task.status !== "completed",
      );
      if (incompleteReview && !acknowledgeIncompleteReview) {
        throw new ApiError(
          "The independent review failed. Retry it before approving, or explicitly acknowledge the incomplete review.",
          409,
          { code: "review-incomplete" },
        );
      }

      const unresolvedQuestions = state.findings.flatMap((finding) =>
        finding.openQuestions.filter((question) => question.status === "open"),
      );
      const next = touch(state, {
        status: "completed",
        approval: {
          approvedAt: now().toISOString(),
          unresolvedQuestionIds: unresolvedQuestions.map((question) => question.id),
          reviewFailureAcknowledged: incompleteReview,
          note,
        },
      });
      states.set(caseId, next);
      return wait(clone({ case: next.case, unresolvedQuestions }));
    },

    async listUsageCasesAsync() {
      const rows = [...states.values()]
        .map(toUsageRow)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return wait({ cases: rows });
    },

    async getUsageSummaryAsync(): Promise<UsageSummary> {
      const all = [...states.values()];
      const byUseCase = Object.fromEntries(
        (["data-analysis", "tax-notice", "msme-payment"] as const).map((useCase) => [
          useCase,
          totalsFor(all.filter((state) => state.case.useCase === useCase)),
        ]),
      );
      const byIntakeMode = Object.fromEntries(
        (["chat", "form"] as const).map((mode) => {
          const inMode = all.filter((state) => state.case.intake?.mode === mode);
          return [
            mode,
            {
              cases: inMode.length,
              submitted: inMode.filter((state) => state.tasks.length > 0).length,
              switchedIn: inMode.filter((state) => state.case.intake?.switchedFrom).length,
            },
          ];
        }),
      );
      return wait({ totals: totalsFor(all), byUseCase, byIntakeMode });
    },
  };

  return dataSource;
}
