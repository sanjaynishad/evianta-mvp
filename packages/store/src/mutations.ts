import { randomUUID } from "node:crypto";

import {
  agentRoleSchema,
  caseSchema,
  deliverableSchema,
  findingSchema,
  runEventSchema,
  taskSchema,
  type AgentProfile,
  type Case,
  type CaseStatus,
  type Deliverable,
  type Finding,
  type NewRunEvent,
  type RunEvent,
  type Task,
} from "@evianta/core";

import { StoreNotFoundError } from "./errors.js";
import type {
  ApprovalInput,
  CaseUsageIncrement,
  CreateCaseInput,
  ListAllCasesOptions,
  OpenQuestionUpdate,
  SectionUpdate,
  TaskUpdate,
} from "./types.js";

export const defaultCasePageSize = 50;

export const maxCasePageSize = 200;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function buildNewCase(input: CreateCaseInput): Case {
  const now = nowIso();

  return caseSchema.parse({
    id: input.id ?? newId(),
    title: input.title,
    description: input.description,
    useCase: input.useCase,
    status: input.status,
    visitorId: input.visitorId,
    isSample: input.isSample ?? false,
    createdAt: now,
    updatedAt: now,
  });
}

export function applyCaseStatus(current: Case, status: CaseStatus): Case {
  return caseSchema.parse({ ...current, status, updatedAt: nowIso() });
}

export function applyCaseUsageIncrement(current: Case, increment: CaseUsageIncrement): Case {
  const usage = current.usage ?? { inputTokens: 0, outputTokens: 0, costEstimate: 0, runCount: 0 };

  return caseSchema.parse({
    ...current,
    usage: {
      inputTokens: usage.inputTokens + (increment.inputTokens ?? 0),
      outputTokens: usage.outputTokens + (increment.outputTokens ?? 0),
      costEstimate: usage.costEstimate + (increment.costEstimate ?? 0),
      runCount: usage.runCount + (increment.runCount ?? 0),
      lastRunAt: increment.lastRunAt ?? usage.lastRunAt,
    },
    updatedAt: nowIso(),
  });
}

export function applyCaseApproval(current: Case, approval: ApprovalInput): Case {
  const now = nowIso();

  return caseSchema.parse({
    ...current,
    approval: {
      approvedAt: approval.approvedAt ?? now,
      unresolvedQuestionIds: approval.unresolvedQuestionIds ?? [],
      note: approval.note,
    },
    updatedAt: now,
  });
}

export function buildCaseCopy(source: Case, visitorId: string): Case {
  const now = nowIso();

  return caseSchema.parse({
    id: newId(),
    title: source.title,
    description: source.description,
    useCase: source.useCase,
    status: source.status,
    visitorId,
    isSample: false,
    sourceCaseId: source.id,
    createdAt: now,
    updatedAt: now,
  });
}

export function compareCasesNewestFirst(left: Case, right: Case): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? 1 : -1;
  }

  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? 1 : -1;
}

export function resolvePageSize(options: ListAllCasesOptions | undefined): number {
  const requested = options?.limit ?? defaultCasePageSize;

  if (!Number.isInteger(requested) || requested < 1) {
    return defaultCasePageSize;
  }

  return Math.min(requested, maxCasePageSize);
}

export function applyTaskUpdate(current: Task, update: TaskUpdate): Task {
  const next: Record<string, unknown> = { ...current };

  if (update.status !== undefined) {
    next.status = update.status;
  }

  if (update.tokenUsage !== undefined) {
    next.tokenUsage = update.tokenUsage;
  }

  if (update.costEstimate !== undefined) {
    next.costEstimate = update.costEstimate;
  }

  if (update.attempts !== undefined) {
    next.attempts = update.attempts;
  }

  if (update.lastError === null) {
    delete next.lastError;
  } else if (update.lastError !== undefined) {
    next.lastError = update.lastError;
  }

  return taskSchema.parse(next);
}

export function findingHasQuestion(finding: Finding, questionId: string): boolean {
  return finding.openQuestions.some((question) => question.id === questionId);
}

export function applyOpenQuestionUpdate(
  finding: Finding,
  questionId: string,
  update: OpenQuestionUpdate,
): Finding {
  if (!findingHasQuestion(finding, questionId)) {
    throw new StoreNotFoundError("open-question", questionId);
  }

  const now = nowIso();
  const openQuestions = finding.openQuestions.map((question) => {
    if (question.id !== questionId) {
      return question;
    }

    if (update.status === "open") {
      return {
        id: question.id,
        text: question.text,
        severity: question.severity,
        status: update.status,
        resolutionNote: update.resolutionNote,
      };
    }

    return {
      ...question,
      status: update.status,
      resolutionNote: update.resolutionNote ?? question.resolutionNote,
      resolvedAt: now,
    };
  });

  return findingSchema.parse({ ...finding, openQuestions });
}

export function applySectionUpdate(
  deliverable: Deliverable,
  sectionId: string,
  update: SectionUpdate,
): Deliverable {
  const now = nowIso();
  let found = false;
  const sections = deliverable.sections.map((section) => {
    if (section.id !== sectionId) {
      return section;
    }

    found = true;
    const next: Record<string, unknown> = { ...section };

    if (update.editedContent === null) {
      delete next.editedContent;
      delete next.editedAt;
    } else if (update.editedContent !== undefined) {
      next.editedContent = update.editedContent;
      next.editedAt = now;
    }

    if (update.reviewStatus !== undefined) {
      next.reviewStatus = update.reviewStatus;
      next.reviewedAt = now;
    }

    if (update.reviewComment === null) {
      delete next.reviewComment;
    } else if (update.reviewComment !== undefined) {
      next.reviewComment = update.reviewComment;
    }

    return next;
  });

  if (!found) {
    throw new StoreNotFoundError("deliverable-section", sectionId);
  }

  return deliverableSchema.parse({ ...deliverable, sections });
}

export function assertDeliverableIdentity(
  deliverable: Deliverable,
  caseId: string,
  deliverableId: string,
): void {
  if (deliverable.caseId !== caseId || deliverable.id !== deliverableId) {
    throw new Error(
      `Deliverable update must keep case "${caseId}" and id "${deliverableId}", got "${deliverable.caseId}" and "${deliverable.id}".`,
    );
  }
}

export function buildRunEvent(caseId: string, seq: number, input: NewRunEvent): RunEvent {
  return runEventSchema.parse({
    ...input,
    caseId,
    seq,
    timestamp: input.timestamp ?? nowIso(),
  });
}

export function compareProfilesByRole(left: AgentProfile, right: AgentProfile): number {
  return agentRoleSchema.options.indexOf(left.role) - agentRoleSchema.options.indexOf(right.role);
}
