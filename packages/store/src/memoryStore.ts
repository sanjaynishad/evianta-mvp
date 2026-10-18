import {
  agentProfileSchema,
  deliverableSchema,
  documentMetadataSchema,
  evidenceSchema,
  extractedDocumentSchema,
  findingSchema,
  sourceConnectionSchema,
  taskSchema,
  type AgentProfile,
  type AgentRole,
  type Case,
  type ChatMessage,
  type Deliverable,
  type DocumentMetadata,
  type Evidence,
  type ExtractedDocument,
  type Finding,
  type RunEvent,
  type SourceConnection,
  type Task,
} from "@evianta/core";

import {
  StoreConflictError,
  StoreLeaseLostError,
  StoreNotFoundError,
  type StoreEntity,
} from "./errors.js";
import {
  addChargeAmounts,
  applyCaseApproval,
  applyCaseDetails,
  applyCaseIntake,
  assertDeliverableIdentity,
  applyCaseStatus,
  applyCaseUsageIncrement,
  applyConnectionImport,
  applyOpenQuestionUpdate,
  applySectionUpdate,
  applyTaskCharge,
  applyTaskUpdate,
  buildCaseCopy,
  buildChatMessage,
  buildNewCase,
  buildRunEvent,
  caseUsageAmounts,
  compareCasesNewestFirst,
  compareConnectionsOldestFirst,
  compareMessagesByCreatedAt,
  compareProfilesByRole,
  clearCaseApproval,
  emptyUsageAmounts,
  findingHasQuestion,
  isLeaseHeld,
  resolvePageSize,
  usageChargeSchema,
  type StoredLease,
} from "./mutations.js";
import type { LeaseFence, Store, UsageCharge } from "./types.js";

class CaseScopedCollection<T> {
  private readonly byCase = new Map<string, Map<string, T>>();

  constructor(private readonly entity: StoreEntity) {}

  list(caseId: string): T[] {
    return [...(this.byCase.get(caseId)?.values() ?? [])].map((item) => structuredClone(item));
  }

  get(caseId: string, id: string): T | undefined {
    const item = this.byCase.get(caseId)?.get(id);

    return item === undefined ? undefined : structuredClone(item);
  }

  getOrThrow(caseId: string, id: string): T {
    const item = this.get(caseId, id);

    if (item === undefined) {
      throw new StoreNotFoundError(this.entity, id);
    }

    return item;
  }

  create(caseId: string, id: string, item: T): T {
    if (this.byCase.get(caseId)?.has(id)) {
      throw new StoreConflictError(this.entity, id);
    }

    return this.put(caseId, id, item);
  }

  put(caseId: string, id: string, item: T): T {
    let items = this.byCase.get(caseId);

    if (!items) {
      items = new Map();
      this.byCase.set(caseId, items);
    }

    items.set(id, structuredClone(item));

    return structuredClone(item);
  }

  copyCase(sourceCaseId: string, targetCaseId: string, transform: (item: T) => T): void {
    const source = this.byCase.get(sourceCaseId);

    if (!source) {
      return;
    }

    const target = new Map<string, T>();

    for (const [id, item] of source) {
      target.set(id, transform(structuredClone(item)));
    }

    this.byCase.set(targetCaseId, target);
  }
}

export function createInMemoryStore(): Store {
  const profiles = new Map<AgentRole, AgentProfile>();
  const cases = new Map<string, Case>();
  const tasks = new CaseScopedCollection<Task>("task");
  const findings = new CaseScopedCollection<Finding>("finding");
  const evidence = new CaseScopedCollection<Evidence>("evidence");
  const deliverables = new CaseScopedCollection<Deliverable>("deliverable");
  const documents = new CaseScopedCollection<DocumentMetadata>("document");
  const extractions = new CaseScopedCollection<ExtractedDocument>("extraction");
  const events = new CaseScopedCollection<RunEvent>("event");
  const messages = new CaseScopedCollection<ChatMessage>("chat-message");
  const connections = new Map<string, SourceConnection>();
  const leases = new Map<string, StoredLease>();
  const charges = new Map<
    string,
    Map<string, { runId: string; charge: UsageCharge; applied: boolean }>
  >();

  function assertFence(caseId: string, fence: LeaseFence | undefined): void {
    if (fence && !isLeaseHeld(leases.get(caseId), fence.leaseOwner)) {
      throw new StoreLeaseLostError(caseId, fence.leaseOwner);
    }
  }

  function getCaseOrThrow(caseId: string): Case {
    const found = cases.get(caseId);

    if (!found) {
      throw new StoreNotFoundError("case", caseId);
    }

    return structuredClone(found);
  }

  function putCase(value: Case): Case {
    cases.set(value.id, structuredClone(value));

    return structuredClone(value);
  }

  return {
    runs: {
      async acquireLeaseAsync(caseId, owner, ttlMs) {
        getCaseOrThrow(caseId);
        const lease = leases.get(caseId);

        if (lease && lease.expiresAt > Date.now()) {
          return false;
        }

        leases.set(caseId, { owner, expiresAt: Date.now() + ttlMs });

        return true;
      },
      async renewLeaseAsync(caseId, owner, ttlMs) {
        const lease = leases.get(caseId);

        if (!lease || !isLeaseHeld(lease, owner)) {
          return false;
        }

        lease.expiresAt = Date.now() + ttlMs;

        return true;
      },
      async releaseLeaseAsync(caseId, owner) {
        if (leases.get(caseId)?.owner === owner) {
          leases.delete(caseId);
        }
      },
      async recordChargeAsync(caseId, runId, chargeId, charge) {
        const parsed = usageChargeSchema.parse(charge);
        let journal = charges.get(caseId);

        if (!journal) {
          journal = new Map();
          charges.set(caseId, journal);
        }

        const key = JSON.stringify([runId, chargeId]);

        if (!journal.has(key)) {
          journal.set(key, { runId, charge: parsed, applied: false });
        }
      },
      async reconcileUsageAsync(caseId) {
        const journal = charges.get(caseId);
        let applied = 0;

        for (const entry of journal?.values() ?? []) {
          if (entry.applied) {
            continue;
          }

          const { taskId } = entry.charge;
          const caseUpdate = applyCaseUsageIncrement(getCaseOrThrow(caseId), entry.charge);
          const task = taskId === undefined ? undefined : tasks.get(caseId, taskId);
          const taskUpdate = task ? applyTaskCharge(task, entry.charge) : undefined;

          putCase(caseUpdate);

          if (taskUpdate) {
            tasks.put(caseId, taskUpdate.id, taskUpdate);
          }

          entry.applied = true;
          applied += 1;
        }

        return applied;
      },
      async getUsageTotalsAsync(caseId, runId) {
        let caseTotals = caseUsageAmounts(getCaseOrThrow(caseId));
        let runTotals = emptyUsageAmounts();

        for (const entry of charges.get(caseId)?.values() ?? []) {
          if (!entry.applied) {
            caseTotals = addChargeAmounts(caseTotals, entry.charge);
          }

          if (entry.runId === runId) {
            runTotals = addChargeAmounts(runTotals, entry.charge);
          }
        }

        return { case: caseTotals, run: runTotals };
      },
    },
    agents: {
      async listProfilesAsync(options) {
        return [...profiles.values()]
          .filter((profile) => !options?.enabledOnly || profile.enabled)
          .sort(compareProfilesByRole)
          .map((profile) => structuredClone(profile));
      },
      async getProfileAsync(role) {
        const profile = profiles.get(role);

        return profile === undefined ? undefined : structuredClone(profile);
      },
      async upsertProfileAsync(input) {
        const profile = agentProfileSchema.parse(input);
        profiles.set(profile.role, structuredClone(profile));

        return profile;
      },
    },
    cases: {
      async createCaseAsync(input) {
        const created = buildNewCase(input);

        if (cases.has(created.id)) {
          throw new StoreConflictError("case", created.id);
        }

        return putCase(created);
      },
      async getCaseAsync(caseId) {
        const found = cases.get(caseId);

        return found === undefined ? undefined : structuredClone(found);
      },
      async listCasesForVisitorAsync(visitorId) {
        return [...cases.values()]
          .filter((item) => item.visitorId === visitorId && !item.isSample)
          .sort(compareCasesNewestFirst)
          .map((item) => structuredClone(item));
      },
      async listSampleCasesAsync() {
        return [...cases.values()]
          .filter((item) => item.isSample)
          .sort(compareCasesNewestFirst)
          .map((item) => structuredClone(item));
      },
      async listAllCasesAsync(options) {
        const pageSize = resolvePageSize(options);
        const sorted = [...cases.values()].sort(compareCasesNewestFirst);
        let start = 0;

        if (options?.cursor !== undefined) {
          const cursorIndex = sorted.findIndex((item) => item.id === options.cursor);

          if (cursorIndex === -1) {
            throw new StoreNotFoundError("case", options.cursor);
          }

          start = cursorIndex + 1;
        }

        const page = sorted.slice(start, start + pageSize).map((item) => structuredClone(item));
        const hasMore = start + pageSize < sorted.length;

        return { cases: page, nextCursor: hasMore ? page.at(-1)?.id : undefined };
      },
      async updateCaseStatusAsync(caseId, status, fence) {
        assertFence(caseId, fence);

        return putCase(applyCaseStatus(getCaseOrThrow(caseId), status));
      },
      async updateCaseUsageAsync(caseId, increment) {
        return putCase(applyCaseUsageIncrement(getCaseOrThrow(caseId), increment));
      },
      async updateCaseDetailsAsync(caseId, details) {
        return putCase(applyCaseDetails(getCaseOrThrow(caseId), details));
      },
      async updateIntakeAsync(caseId, update) {
        const current = getCaseOrThrow(caseId);

        return putCase(applyCaseIntake(current, update(current.intake, current)));
      },
      async recordApprovalAsync(caseId, approval) {
        return putCase(applyCaseApproval(getCaseOrThrow(caseId), approval));
      },
      async clearApprovalAsync(caseId) {
        return putCase(clearCaseApproval(getCaseOrThrow(caseId)));
      },
      async copyCaseAsync(sourceCaseId, visitorId) {
        const copy = buildCaseCopy(getCaseOrThrow(sourceCaseId), visitorId);
        const withCaseId = <T extends { caseId: string }>(item: T): T => ({
          ...item,
          caseId: copy.id,
        });
        const unchanged = <T>(item: T): T => item;

        tasks.copyCase(sourceCaseId, copy.id, withCaseId);
        findings.copyCase(sourceCaseId, copy.id, unchanged);
        evidence.copyCase(sourceCaseId, copy.id, unchanged);
        deliverables.copyCase(sourceCaseId, copy.id, withCaseId);
        documents.copyCase(sourceCaseId, copy.id, withCaseId);
        extractions.copyCase(sourceCaseId, copy.id, unchanged);
        events.copyCase(sourceCaseId, copy.id, withCaseId);
        messages.copyCase(sourceCaseId, copy.id, withCaseId);

        return putCase(copy);
      },
    },
    tasks: {
      async createTaskAsync(input) {
        const task = taskSchema.parse(input);

        return tasks.create(task.caseId, task.id, task);
      },
      async createTasksAsync(caseId, inputs, fence) {
        assertFence(caseId, fence);
        const parsed = inputs.map((input) => taskSchema.parse(input));
        const seen = new Set<string>();

        for (const task of parsed) {
          if (task.caseId !== caseId) {
            throw new Error(`Task "${task.id}" does not belong to case "${caseId}".`);
          }

          if (seen.has(task.id) || tasks.get(caseId, task.id) !== undefined) {
            throw new StoreConflictError("task", task.id);
          }

          seen.add(task.id);
        }

        return parsed.map((task) => tasks.create(caseId, task.id, task));
      },
      async getTasksForCaseAsync(caseId) {
        return tasks.list(caseId);
      },
      async updateTaskAsync(caseId, taskId, update, fence) {
        assertFence(caseId, fence);
        const next = applyTaskUpdate(tasks.getOrThrow(caseId, taskId), update);

        return tasks.put(caseId, taskId, next);
      },
    },
    findings: {
      async addFindingAsync(caseId, input, fence) {
        assertFence(caseId, fence);
        const finding = findingSchema.parse(input);

        return findings.create(caseId, finding.id, finding);
      },
      async getFindingsForCaseAsync(caseId) {
        return findings.list(caseId);
      },
      async updateOpenQuestionAsync(caseId, questionId, update) {
        const finding = findings
          .list(caseId)
          .find((candidate) => findingHasQuestion(candidate, questionId));

        if (!finding) {
          throw new StoreNotFoundError("open-question", questionId);
        }

        return findings.put(
          caseId,
          finding.id,
          applyOpenQuestionUpdate(finding, questionId, update),
        );
      },
    },
    evidence: {
      async addEvidenceAsync(caseId, input, fence) {
        assertFence(caseId, fence);
        const item = evidenceSchema.parse(input);

        return evidence.create(caseId, item.id, item);
      },
      async getEvidenceForCaseAsync(caseId) {
        return evidence.list(caseId);
      },
    },
    deliverables: {
      async saveDeliverableAsync(input) {
        const deliverable = deliverableSchema.parse(input);

        return deliverables.put(deliverable.caseId, deliverable.id, deliverable);
      },
      async updateDeliverableAsync(caseId, deliverableId, update, fence) {
        assertFence(caseId, fence);
        const current = deliverables.get(caseId, deliverableId);
        const input = update(current);

        if (input === undefined) {
          return current;
        }

        const next = deliverableSchema.parse(input);

        assertDeliverableIdentity(next, caseId, deliverableId);

        return deliverables.put(caseId, deliverableId, next);
      },
      async getDeliverablesForCaseAsync(caseId) {
        return deliverables.list(caseId);
      },
      async getDeliverableAsync(caseId, deliverableId) {
        return deliverables.get(caseId, deliverableId);
      },
      async updateSectionAsync(caseId, deliverableId, sectionId, update) {
        const next = applySectionUpdate(
          deliverables.getOrThrow(caseId, deliverableId),
          sectionId,
          update,
        );

        const caseRecord = cases.get(caseId);

        if (update.editedContent !== undefined && caseRecord?.approval) {
          const nextCase = { ...caseRecord, updatedAt: new Date().toISOString() };

          delete nextCase.approval;
          putCase(nextCase);
        }

        return deliverables.put(caseId, deliverableId, next);
      },
    },
    documents: {
      async addDocumentMetadataAsync(input) {
        const metadata = documentMetadataSchema.parse(input);

        return documents.create(metadata.caseId, metadata.id, metadata);
      },
      async getDocumentsForCaseAsync(caseId) {
        return documents.list(caseId);
      },
      async getDocumentAsync(caseId, documentId) {
        return documents.get(caseId, documentId);
      },
      async saveExtractionAsync(caseId, input) {
        const extraction = extractedDocumentSchema.parse(input);

        return extractions.put(caseId, extraction.documentId, extraction);
      },
      async getExtractionAsync(caseId, documentId) {
        return extractions.get(caseId, documentId);
      },
    },
    events: {
      async appendEventAsync(caseId, input) {
        const lastSeq = events.list(caseId).at(-1)?.seq ?? 0;
        const event = buildRunEvent(caseId, lastSeq + 1, input);

        return events.create(caseId, String(event.seq), event);
      },
      async listEventsAsync(caseId, afterSeq = 0) {
        return events.list(caseId).filter((event) => event.seq > afterSeq);
      },
    },
    chat: {
      async appendMessageAsync(caseId, input) {
        const message = buildChatMessage(caseId, input);

        return messages.create(caseId, message.id, message);
      },
      async listMessagesAsync(caseId) {
        return messages.list(caseId).sort(compareMessagesByCreatedAt);
      },
    },
    connections: {
      async createConnectionAsync(input) {
        const connection = sourceConnectionSchema.parse(input);

        if (connections.has(connection.id)) {
          throw new StoreConflictError("source-connection", connection.id);
        }

        connections.set(connection.id, structuredClone(connection));

        return connection;
      },
      async listConnectionsForVisitorAsync(visitorId) {
        return [...connections.values()]
          .filter((connection) => connection.visitorId === visitorId)
          .sort(compareConnectionsOldestFirst)
          .map((connection) => structuredClone(connection));
      },
      async getConnectionAsync(connectionId) {
        const connection = connections.get(connectionId);

        return connection === undefined ? undefined : structuredClone(connection);
      },
      async deleteConnectionAsync(connectionId) {
        connections.delete(connectionId);
      },
      async touchConnectionAsync(connectionId, lastImportAt) {
        const connection = connections.get(connectionId);

        if (!connection) {
          throw new StoreNotFoundError("source-connection", connectionId);
        }

        const next = applyConnectionImport(structuredClone(connection), lastImportAt);

        connections.set(connectionId, structuredClone(next));

        return next;
      },
    },
  };
}
