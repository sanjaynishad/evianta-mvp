import type { ExtractedDocumentInput, NewRunEvent } from "@evianta/core";
import { beforeEach, describe, expect, it } from "vitest";

import type { DocumentStore } from "./documents/documentStore.js";
import { StoreConflictError, StoreLeaseLostError, StoreNotFoundError } from "./errors.js";
import type { CreateCaseInput, Store } from "./types.js";

export interface StoreContractContext {
  store: Store;
  documentStore: DocumentStore;
}

export type StoreContractFactory = () => Promise<StoreContractContext>;

const usage = { input: 1200, output: 300, total: 1500 };

function sleepAsync(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function caseInput(overrides: Partial<CreateCaseInput> = {}): CreateCaseInput {
  return { title: "Notice under section 143(1)", useCase: "tax-notice", ...overrides };
}

function extractionInput(
  documentId: string,
  text = "Demand of Rs. 48,210",
): ExtractedDocumentInput {
  return {
    documentId,
    kind: "text",
    method: "mixed",
    confidence: 0.8,
    pages: [
      {
        index: 1,
        text,
        width: 595,
        height: 842,
        method: "pdf-text",
        confidence: 1,
        spans: [{ text: "Rs. 48,210", bbox: { x: 0.5, y: 0.2, width: 0.1, height: 0.02 } }],
      },
      { index: 2, text: "Annexure", method: "ocr", confidence: 0.6 },
    ],
    tables: [
      {
        name: "Ledger",
        sheet: "Ledger",
        columns: [
          { name: "Invoice", type: "string" },
          { name: "Amount", type: "number" },
        ],
        rows: [
          ["INV-1", 1200],
          ["INV-2", null],
        ],
      },
    ],
    warnings: ["Page 2 was scanned"],
  };
}

function runStarted(runId = "run-1"): NewRunEvent {
  return { type: "run-started", runId, taskIds: ["task-1"] };
}

export function describeStoreContract(
  name: string,
  createContextAsync: StoreContractFactory,
): void {
  describe(`${name} store contract`, () => {
    let store: Store;
    let documentStore: DocumentStore;

    beforeEach(async () => {
      ({ store, documentStore } = await createContextAsync());
    });

    it("excludes concurrent lease owners and does not let a non-owner release the lease", async () => {
      const created = await store.cases.createCaseAsync(caseInput());
      const claims = await Promise.all([
        store.runs.acquireLeaseAsync(created.id, "first", 60_000),
        store.runs.acquireLeaseAsync(created.id, "second", 60_000),
      ]);
      const winner = claims[0] ? "first" : "second";
      const loser = claims[0] ? "second" : "first";

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await store.runs.renewLeaseAsync(created.id, loser, 60_000)).toBe(false);
      await store.runs.releaseLeaseAsync(created.id, loser);
      expect(await store.runs.acquireLeaseAsync(created.id, loser, 60_000)).toBe(false);
      expect(await store.runs.renewLeaseAsync(created.id, winner, 60_000)).toBe(true);
      await store.runs.releaseLeaseAsync(created.id, winner);
      expect(await store.runs.acquireLeaseAsync(created.id, loser, 60_000)).toBe(true);
    });

    it("allows takeover after lease expiry without letting the old owner renew or release it", async () => {
      const created = await store.cases.createCaseAsync(caseInput());

      expect(await store.runs.acquireLeaseAsync(created.id, "first", 1)).toBe(true);
      await sleepAsync(10);
      expect(await store.runs.renewLeaseAsync(created.id, "first", 60_000)).toBe(false);
      expect(await store.runs.acquireLeaseAsync(created.id, "second", 60_000)).toBe(true);
      await store.runs.releaseLeaseAsync(created.id, "first");
      expect(await store.runs.acquireLeaseAsync(created.id, "third", 60_000)).toBe(false);
    });

    it("journals charges idempotently and reconciles them once under contention", async () => {
      const created = await store.cases.createCaseAsync(caseInput());
      const increment = { inputTokens: 100, outputTokens: 20, costEstimate: 0.01 };

      await Promise.all([
        store.runs.recordChargeAsync(created.id, "run-1", "task:1", increment),
        store.runs.recordChargeAsync(created.id, "run-1", "task:1", increment),
      ]);
      await store.runs.recordChargeAsync(created.id, "run-1", "run", { runCount: 1 });
      await store.runs.recordChargeAsync(created.id, "run-1", "planning", increment);
      expect((await store.cases.getCaseAsync(created.id))?.usage?.inputTokens ?? 0).toBe(0);
      await Promise.all([
        store.runs.reconcileUsageAsync(created.id),
        store.runs.reconcileUsageAsync(created.id),
      ]);

      expect((await store.cases.getCaseAsync(created.id))?.usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 40,
        costEstimate: 0.02,
        runCount: 1,
      });
      expect(await store.runs.reconcileUsageAsync(created.id)).toBe(0);
    });

    it("adds task charges to the task totals once and skips tasks that do not exist", async () => {
      const created = await store.cases.createCaseAsync(caseInput());

      await store.tasks.createTaskAsync({
        id: "task-1",
        caseId: created.id,
        title: "Reconcile",
        assignedRole: "reconciliation",
        tokenUsage: { input: 10, output: 5, total: 15 },
        costEstimate: 0.001,
      });

      const charge = {
        taskId: "task-1",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 130,
        costEstimate: 0.01,
      };

      await Promise.all([
        store.runs.recordChargeAsync(created.id, "run-1", "task:task-1:1", charge),
        store.runs.recordChargeAsync(created.id, "run-1", "task:task-1:1", charge),
      ]);
      await store.runs.recordChargeAsync(created.id, "run-1", "task:task-2:1", {
        taskId: "task-2",
        inputTokens: 7,
      });
      await expect(
        store.runs.recordChargeAsync(created.id, "run-1", "task:task-1:2", {
          taskId: "task-1",
          inputTokens: 10,
          totalTokens: 0.5,
        }),
      ).rejects.toThrow();

      const [task] = await store.tasks.getTasksForCaseAsync(created.id);

      expect(task?.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });

      const applied = await Promise.all([
        store.runs.reconcileUsageAsync(created.id),
        store.runs.reconcileUsageAsync(created.id),
      ]);
      const [charged] = await store.tasks.getTasksForCaseAsync(created.id);

      expect(applied[0] + applied[1]).toBe(2);
      expect(charged?.tokenUsage).toEqual({ input: 110, output: 25, total: 145 });
      expect(charged?.costEstimate).toBeCloseTo(0.011, 10);
      expect(charged?.status).toBe("pending");
      expect((await store.cases.getCaseAsync(created.id))?.usage).toMatchObject({
        inputTokens: 107,
        outputTokens: 20,
      });
      expect(await store.tasks.getTasksForCaseAsync(created.id)).toHaveLength(1);
      expect(await store.runs.reconcileUsageAsync(created.id)).toBe(0);
    });

    it("reports case usage with unapplied charges and every charge of one run", async () => {
      const created = await store.cases.createCaseAsync(caseInput());

      await store.runs.recordChargeAsync(created.id, "run-1", "task:a:1", {
        taskId: "a",
        inputTokens: 100,
        outputTokens: 10,
        costEstimate: 0.01,
      });
      await store.runs.recordChargeAsync(created.id, "run-0", "task:a:0", {
        inputTokens: 40,
        outputTokens: 4,
        costEstimate: 0.004,
      });
      await store.runs.reconcileUsageAsync(created.id);
      await store.runs.recordChargeAsync(created.id, "run-1", "task:b:1", {
        inputTokens: 20,
        outputTokens: 2,
        costEstimate: 0.002,
      });
      await store.runs.recordChargeAsync(created.id, "run-2", "task:c:1", {
        inputTokens: 7,
        outputTokens: 1,
        costEstimate: 0.001,
      });

      const before = await store.runs.getUsageTotalsAsync(created.id, "run-1");

      await store.runs.reconcileUsageAsync(created.id);

      const after = await store.runs.getUsageTotalsAsync(created.id, "run-1");

      for (const totals of [before, after]) {
        expect(totals.case).toMatchObject({ inputTokens: 167, outputTokens: 17 });
        expect(totals.case.costEstimate).toBeCloseTo(0.017, 10);
        expect(totals.run).toMatchObject({ inputTokens: 120, outputTokens: 12 });
        expect(totals.run.costEstimate).toBeCloseTo(0.012, 10);
      }

      await expect(store.runs.getUsageTotalsAsync("missing", "run-1")).rejects.toThrow(
        StoreNotFoundError,
      );
    });

    it("commits fenced writes only while the fence owner holds the run lease", async () => {
      const created = await store.cases.createCaseAsync(caseInput());
      const first = { leaseOwner: "first" };
      const second = { leaseOwner: "second" };
      const deliverable = (title: string) => ({
        id: "del-1",
        caseId: created.id,
        title,
        format: "document" as const,
      });

      await expect(
        store.cases.updateCaseStatusAsync(created.id, "in-progress", first),
      ).rejects.toThrow(StoreLeaseLostError);
      expect(await store.runs.acquireLeaseAsync(created.id, "first", 1000)).toBe(true);
      expect(
        (await store.cases.updateCaseStatusAsync(created.id, "in-progress", first)).status,
      ).toBe("in-progress");
      await sleepAsync(1100);
      await expect(store.cases.updateCaseStatusAsync(created.id, "review", first)).rejects.toThrow(
        StoreLeaseLostError,
      );
      expect(await store.runs.acquireLeaseAsync(created.id, "second", 60_000)).toBe(true);
      await store.tasks.createTasksAsync(
        created.id,
        [{ id: "task-1", caseId: created.id, title: "Analyse", assignedRole: "case-analysis" }],
        second,
      );
      await store.deliverables.updateDeliverableAsync(
        created.id,
        "del-1",
        () => deliverable("Second"),
        second,
      );

      const staleWrites: Array<() => Promise<unknown>> = [
        () => store.cases.updateCaseStatusAsync(created.id, "completed", first),
        () =>
          store.tasks.createTasksAsync(
            created.id,
            [{ id: "task-2", caseId: created.id, title: "Stale", assignedRole: "reconciliation" }],
            first,
          ),
        () => store.tasks.updateTaskAsync(created.id, "task-1", { status: "completed" }, first),
        () =>
          store.findings.addFindingAsync(
            created.id,
            { id: "finding-stale", taskId: "task-1", summary: "Stale" },
            first,
          ),
        () =>
          store.evidence.addEvidenceAsync(
            created.id,
            { id: "ev-stale", sourceRef: "Stale", description: "Stale" },
            first,
          ),
        () =>
          store.deliverables.updateDeliverableAsync(
            created.id,
            "del-1",
            () => deliverable("Stale"),
            first,
          ),
      ];

      for (const write of staleWrites) {
        await expect(write()).rejects.toThrow(StoreLeaseLostError);
      }

      expect((await store.cases.getCaseAsync(created.id))?.status).toBe("in-progress");
      expect(await store.tasks.getTasksForCaseAsync(created.id)).toMatchObject([
        { id: "task-1", status: "pending" },
      ]);
      expect(await store.findings.getFindingsForCaseAsync(created.id)).toEqual([]);
      expect(await store.evidence.getEvidenceForCaseAsync(created.id)).toEqual([]);
      expect((await store.deliverables.getDeliverableAsync(created.id, "del-1"))?.title).toBe(
        "Second",
      );

      await store.tasks.updateTaskAsync(created.id, "task-1", { status: "completed" }, second);
      await store.findings.addFindingAsync(
        created.id,
        { id: "finding-1", taskId: "task-1", summary: "Current" },
        second,
      );
      await store.evidence.addEvidenceAsync(
        created.id,
        { id: "ev-1", sourceRef: "Current", description: "Current" },
        second,
      );
      await expect(
        store.evidence.addEvidenceAsync(
          created.id,
          { id: "ev-1", sourceRef: "Current", description: "Current" },
          second,
        ),
      ).rejects.toThrow(StoreConflictError);
      await store.runs.releaseLeaseAsync(created.id, "second");
      await expect(
        store.tasks.updateTaskAsync(created.id, "task-1", { status: "failed" }, second),
      ).rejects.toThrow(StoreLeaseLostError);
      expect((await store.tasks.getTasksForCaseAsync(created.id))[0]?.status).toBe("completed");
    });

    async function seedSampleAsync() {
      const sample = await store.cases.createCaseAsync(
        caseInput({ title: "Sample tax notice", isSample: true, status: "review" }),
      );

      await store.tasks.createTaskAsync({
        id: "task-1",
        caseId: sample.id,
        title: "Analyse notice",
        assignedRole: "case-analysis",
        status: "completed",
        tokenUsage: usage,
        costEstimate: 0.002,
        attempts: 1,
      });
      await store.evidence.addEvidenceAsync(sample.id, {
        id: "ev-1",
        sourceRef: "Notice p.1",
        description: "Demand amount",
        documentId: "doc-1",
        confidence: "high",
        location: { page: 1, textQuote: "Rs. 48,210" },
      });
      await store.findings.addFindingAsync(sample.id, {
        id: "finding-1",
        taskId: "task-1",
        summary: "Demand raised for TDS mismatch",
        severity: "high",
        openQuestions: [{ id: "q-1", text: "Is Form 16 available?", severity: "high" }],
      });
      await store.deliverables.saveDeliverableAsync({
        id: "del-1",
        caseId: sample.id,
        title: "Response draft",
        format: "document",
        sections: [
          {
            id: "sec-1",
            title: "Summary",
            kind: "text",
            content: "The demand arises from a TDS mismatch.",
            producedByRole: "response-preparation",
            modelTier: "mid",
            findingIds: ["finding-1"],
            evidenceIds: ["ev-1"],
          },
        ],
      });
      await store.documents.addDocumentMetadataAsync({
        id: "doc-1",
        caseId: sample.id,
        name: "notice.pdf",
        mimeType: "application/pdf",
        size: 2048,
        gcsPath: `gs://bucket/cases/${sample.id}/documents/doc-1/notice.pdf`,
        uploadedAt: new Date().toISOString(),
      });
      await store.documents.saveExtractionAsync(sample.id, extractionInput("doc-1"));
      await store.events.appendEventAsync(sample.id, runStarted());
      await store.events.appendEventAsync(sample.id, {
        type: "run-completed",
        runId: "run-1",
        totalTokenUsage: usage,
        totalCostEstimate: 0.002,
      });

      return sample;
    }

    describe("agent directory", () => {
      const profile = {
        role: "tax-research",
        displayName: "Tax Research",
        specialty: "Indian income tax",
        summary: "Finds the provisions that apply to a notice.",
        modelTier: "mid",
      } as const;

      it("upserts, reads, and lists profiles in role order", async () => {
        await store.agents.upsertProfileAsync(profile);
        await store.agents.upsertProfileAsync({
          ...profile,
          role: "coordinator",
          displayName: "Coordinator",
          enabled: false,
        });

        const fetched = await store.agents.getProfileAsync("tax-research");
        const all = await store.agents.listProfilesAsync();
        const enabled = await store.agents.listProfilesAsync({ enabledOnly: true });

        expect(fetched).toMatchObject({ displayName: "Tax Research", enabled: true, tools: [] });
        expect(all.map((item) => item.role)).toEqual(["coordinator", "tax-research"]);
        expect(enabled.map((item) => item.role)).toEqual(["tax-research"]);
        expect(await store.agents.getProfileAsync("legal-research")).toBeUndefined();
      });

      it("is idempotent when re-seeded", async () => {
        await store.agents.upsertProfileAsync(profile);
        await store.agents.upsertProfileAsync({ ...profile, summary: "Updated" });

        const all = await store.agents.listProfilesAsync();

        expect(all).toHaveLength(1);
        expect(all[0]?.summary).toBe("Updated");
      });

      it("rejects an invalid profile", async () => {
        await expect(
          store.agents.upsertProfileAsync({ ...profile, modelTier: "ultra" as "mid" }),
        ).rejects.toThrow();
      });
    });

    describe("cases", () => {
      it("creates a case with defaults and reads it back", async () => {
        const created = await store.cases.createCaseAsync(caseInput({ visitorId: "visitor-a" }));
        const fetched = await store.cases.getCaseAsync(created.id);

        expect(created).toMatchObject({ status: "draft", isSample: false, useCase: "tax-notice" });
        expect(fetched).toEqual(created);
        expect(await store.cases.getCaseAsync("missing")).toBeUndefined();
      });

      it("rejects a duplicate id", async () => {
        await store.cases.createCaseAsync(caseInput({ id: "fixed-id" }));

        await expect(store.cases.createCaseAsync(caseInput({ id: "fixed-id" }))).rejects.toThrow(
          StoreConflictError,
        );
      });

      it("scopes cases to their visitor and keeps samples separate", async () => {
        const first = await store.cases.createCaseAsync(caseInput({ visitorId: "visitor-a" }));
        await sleepAsync(5);
        const second = await store.cases.createCaseAsync(caseInput({ visitorId: "visitor-a" }));
        const other = await store.cases.createCaseAsync(caseInput({ visitorId: "visitor-b" }));
        const sample = await store.cases.createCaseAsync(caseInput({ isSample: true }));

        const visitorA = await store.cases.listCasesForVisitorAsync("visitor-a");
        const visitorB = await store.cases.listCasesForVisitorAsync("visitor-b");
        const samples = await store.cases.listSampleCasesAsync();
        const all = await store.cases.listAllCasesAsync();

        expect(visitorA.map((item) => item.id)).toEqual([second.id, first.id]);
        expect(visitorB.map((item) => item.id)).toEqual([other.id]);
        expect(samples.map((item) => item.id)).toEqual([sample.id]);
        expect(all.cases.map((item) => item.id).sort()).toEqual(
          [first.id, second.id, other.id, sample.id].sort(),
        );
        expect(all.nextCursor).toBeUndefined();
      });

      it("paginates every case newest first", async () => {
        const ids: string[] = [];

        for (let index = 0; index < 5; index += 1) {
          const created = await store.cases.createCaseAsync(
            caseInput({ visitorId: `visitor-${index}` }),
          );

          ids.unshift(created.id);
          await sleepAsync(5);
        }

        const firstPage = await store.cases.listAllCasesAsync({ limit: 2 });
        const secondPage = await store.cases.listAllCasesAsync({
          limit: 2,
          cursor: firstPage.nextCursor,
        });
        const lastPage = await store.cases.listAllCasesAsync({
          limit: 2,
          cursor: secondPage.nextCursor,
        });

        expect(firstPage.cases.map((item) => item.id)).toEqual(ids.slice(0, 2));
        expect(secondPage.cases.map((item) => item.id)).toEqual(ids.slice(2, 4));
        expect(lastPage.cases.map((item) => item.id)).toEqual(ids.slice(4));
        expect(lastPage.nextCursor).toBeUndefined();
      });

      it("updates status and records approval", async () => {
        const created = await store.cases.createCaseAsync(caseInput());
        const failed = await store.cases.updateCaseStatusAsync(created.id, "failed");
        const approved = await store.cases.recordApprovalAsync(created.id, {
          unresolvedQuestionIds: ["q-2"],
          note: "Approved with one open item",
        });

        expect(failed.status).toBe("failed");
        expect(approved.approval).toMatchObject({
          unresolvedQuestionIds: ["q-2"],
          note: "Approved with one open item",
        });
        expect(approved.approval?.approvedAt).toEqual(expect.any(String));
        expect(await store.cases.getCaseAsync(created.id)).toEqual(approved);
      });

      it("clears case approval", async () => {
        const created = await store.cases.createCaseAsync(caseInput());

        await store.cases.recordApprovalAsync(created.id, { note: "Old approval" });

        const cleared = await store.cases.clearApprovalAsync(created.id);

        expect(cleared.approval).toBeUndefined();
        expect(await store.cases.getCaseAsync(created.id)).toEqual(cleared);
      });

      it("accumulates the usage summary from task usage", async () => {
        const created = await store.cases.createCaseAsync(caseInput());

        await store.tasks.createTaskAsync({
          id: "task-1",
          caseId: created.id,
          title: "Analyse",
          assignedRole: "case-analysis",
        });
        await store.tasks.updateTaskAsync(created.id, "task-1", {
          status: "completed",
          tokenUsage: usage,
          costEstimate: 0.0025,
          attempts: 1,
        });

        const tasks = await store.tasks.getTasksForCaseAsync(created.id);
        const runTotals = tasks.reduce(
          (totals, task) => ({
            inputTokens: totals.inputTokens + (task.tokenUsage?.input ?? 0),
            outputTokens: totals.outputTokens + (task.tokenUsage?.output ?? 0),
            costEstimate: totals.costEstimate + (task.costEstimate ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0, costEstimate: 0 },
        );

        await store.cases.updateCaseUsageAsync(created.id, {
          ...runTotals,
          runCount: 1,
          lastRunAt: "2026-10-16T00:00:00.000Z",
        });
        const updated = await store.cases.updateCaseUsageAsync(created.id, {
          ...runTotals,
          runCount: 1,
          lastRunAt: "2026-10-16T01:00:00.000Z",
        });

        expect(updated.usage).toEqual({
          inputTokens: 2400,
          outputTokens: 600,
          costEstimate: 0.005,
          runCount: 2,
          lastRunAt: "2026-10-16T01:00:00.000Z",
        });
        expect((await store.cases.getCaseAsync(created.id))?.usage).toEqual(updated.usage);
      });

      it("throws not found when updating a missing case", async () => {
        await expect(store.cases.updateCaseStatusAsync("missing", "review")).rejects.toThrow(
          StoreNotFoundError,
        );
        await expect(store.cases.copyCaseAsync("missing", "visitor-a")).rejects.toThrow(
          StoreNotFoundError,
        );
      });
    });

    describe("copyCaseAsync", () => {
      it("copies a sample with its full work record into the visitor's cases", async () => {
        const sample = await seedSampleAsync();
        const copy = await store.cases.copyCaseAsync(sample.id, "visitor-a");

        expect(copy).toMatchObject({
          title: sample.title,
          useCase: sample.useCase,
          status: "review",
          visitorId: "visitor-a",
          isSample: false,
          sourceCaseId: sample.id,
        });
        expect(copy.id).not.toBe(sample.id);
        expect(copy.usage).toBeUndefined();

        const tasks = await store.tasks.getTasksForCaseAsync(copy.id);
        const findings = await store.findings.getFindingsForCaseAsync(copy.id);
        const evidence = await store.evidence.getEvidenceForCaseAsync(copy.id);
        const deliverables = await store.deliverables.getDeliverablesForCaseAsync(copy.id);
        const documents = await store.documents.getDocumentsForCaseAsync(copy.id);
        const extraction = await store.documents.getExtractionAsync(copy.id, "doc-1");
        const events = await store.events.listEventsAsync(copy.id);
        const sampleDocuments = await store.documents.getDocumentsForCaseAsync(sample.id);

        expect(tasks).toEqual([expect.objectContaining({ id: "task-1", caseId: copy.id })]);
        expect(tasks[0]?.tokenUsage).toEqual(usage);
        expect(findings.map((item) => item.id)).toEqual(["finding-1"]);
        expect(evidence[0]).toMatchObject({ id: "ev-1", location: { page: 1 } });
        expect(deliverables[0]).toMatchObject({ caseId: copy.id, sections: [{ id: "sec-1" }] });
        expect(documents[0]).toMatchObject({
          caseId: copy.id,
          gcsPath: sampleDocuments[0]?.gcsPath,
        });
        expect(extraction).toEqual(await store.documents.getExtractionAsync(sample.id, "doc-1"));
        expect(events.map((event) => [event.seq, event.type, event.caseId])).toEqual([
          [1, "run-started", copy.id],
          [2, "run-completed", copy.id],
        ]);
        expect((await store.cases.listCasesForVisitorAsync("visitor-a")).map((c) => c.id)).toEqual([
          copy.id,
        ]);
        expect((await store.cases.listSampleCasesAsync()).map((c) => c.id)).toEqual([sample.id]);
      });

      it("keeps the sample unchanged when the copy is edited", async () => {
        const sample = await seedSampleAsync();
        const copy = await store.cases.copyCaseAsync(sample.id, "visitor-a");

        await store.cases.updateCaseStatusAsync(copy.id, "in-progress");
        await store.tasks.updateTaskAsync(copy.id, "task-1", { status: "failed", lastError: "x" });
        await store.findings.updateOpenQuestionAsync(copy.id, "q-1", { status: "resolved" });
        await store.deliverables.updateSectionAsync(copy.id, "del-1", "sec-1", {
          editedContent: "Reviewer text",
          reviewStatus: "approved",
        });
        await store.events.appendEventAsync(copy.id, runStarted("run-2"));
        await store.documents.saveExtractionAsync(copy.id, extractionInput("doc-1", "Changed"));

        const sampleAfter = await store.cases.getCaseAsync(sample.id);
        const sampleTasks = await store.tasks.getTasksForCaseAsync(sample.id);
        const sampleFindings = await store.findings.getFindingsForCaseAsync(sample.id);
        const sampleDeliverable = await store.deliverables.getDeliverableAsync(sample.id, "del-1");
        const sampleEvents = await store.events.listEventsAsync(sample.id);
        const sampleExtraction = await store.documents.getExtractionAsync(sample.id, "doc-1");
        const copyEvents = await store.events.listEventsAsync(copy.id);

        expect(sampleAfter).toEqual(sample);
        expect(sampleTasks[0]).toMatchObject({ status: "completed" });
        expect(sampleTasks[0]?.lastError).toBeUndefined();
        expect(sampleFindings[0]?.openQuestions[0]?.status).toBe("open");
        expect(sampleDeliverable?.sections[0]).toMatchObject({ reviewStatus: "pending" });
        expect(sampleDeliverable?.sections[0]?.editedContent).toBeUndefined();
        expect(sampleEvents).toHaveLength(2);
        expect(sampleExtraction?.pages[0]?.text).toBe("Demand of Rs. 48,210");
        expect(copyEvents.at(-1)).toMatchObject({ seq: 3, runId: "run-2" });
      });

      it("copies a complete extraction while the sample's extraction is replaced", async () => {
        const sample = await seedSampleAsync();

        await store.documents.saveExtractionAsync(
          sample.id,
          extractionInput("doc-1", "v0 ".repeat(90_000)),
        );

        const writes = (async () => {
          for (let round = 1; round <= 3; round += 1) {
            await store.documents.saveExtractionAsync(
              sample.id,
              extractionInput("doc-1", `v${round} `.repeat(90_000)),
            );
          }
        })();
        const copies = (async () => {
          const copyIds: string[] = [];

          for (let round = 0; round < 3; round += 1) {
            copyIds.push((await store.cases.copyCaseAsync(sample.id, "visitor-a")).id);
          }

          return copyIds;
        })();

        const [, copyIds] = await Promise.all([writes, copies]);

        for (const copyId of copyIds) {
          const extraction = await store.documents.getExtractionAsync(copyId, "doc-1");

          expect(extraction?.pages[0]?.text).toMatch(/^v\d /);
        }
      });
    });

    describe("tasks", () => {
      it("creates tasks with defaults and lists them in insertion order", async () => {
        await store.tasks.createTaskAsync({
          id: "task-10",
          caseId: "case-1",
          title: "First",
          assignedRole: "case-analysis",
        });
        await store.tasks.createTaskAsync({
          id: "task-2",
          caseId: "case-1",
          title: "Second",
          assignedRole: "reconciliation",
          dependsOn: ["task-10"],
        });

        const tasks = await store.tasks.getTasksForCaseAsync("case-1");

        expect(tasks.map((task) => task.id)).toEqual(["task-10", "task-2"]);
        expect(tasks[0]).toMatchObject({ status: "pending", attempts: 0, dependsOn: [] });
        expect(await store.tasks.getTasksForCaseAsync("case-2")).toEqual([]);
      });

      it("creates a batch of tasks atomically", async () => {
        await store.tasks.createTaskAsync({
          id: "task-existing",
          caseId: "case-1",
          title: "Existing",
          assignedRole: "case-analysis",
        });

        const created = await store.tasks.createTasksAsync("case-2", [
          { id: "task-a", caseId: "case-2", title: "A", assignedRole: "case-analysis" },
          {
            id: "task-b",
            caseId: "case-2",
            title: "B",
            assignedRole: "reconciliation",
            dependsOn: ["task-a"],
          },
        ]);

        expect(created.map((task) => task.status)).toEqual(["pending", "pending"]);
        expect((await store.tasks.getTasksForCaseAsync("case-2")).map((task) => task.id)).toEqual([
          "task-a",
          "task-b",
        ]);

        await expect(
          store.tasks.createTasksAsync("case-1", [
            { id: "task-new", caseId: "case-1", title: "New", assignedRole: "reconciliation" },
            { id: "task-existing", caseId: "case-1", title: "Dup", assignedRole: "case-analysis" },
          ]),
        ).rejects.toThrow(StoreConflictError);
        expect((await store.tasks.getTasksForCaseAsync("case-1")).map((task) => task.id)).toEqual([
          "task-existing",
        ]);
      });

      it("persists usage, attempts, and errors, and clears the error", async () => {
        await store.tasks.createTaskAsync({
          id: "task-1",
          caseId: "case-1",
          title: "Reconcile",
          assignedRole: "reconciliation",
        });

        const failed = await store.tasks.updateTaskAsync("case-1", "task-1", {
          status: "failed",
          attempts: 1,
          lastError: "Ledger could not be parsed",
        });
        const retried = await store.tasks.updateTaskAsync("case-1", "task-1", {
          status: "completed",
          attempts: 2,
          tokenUsage: usage,
          costEstimate: 0.003,
          lastError: null,
        });
        const [stored] = await store.tasks.getTasksForCaseAsync("case-1");

        expect(failed).toMatchObject({ status: "failed", lastError: "Ledger could not be parsed" });
        expect(retried.lastError).toBeUndefined();
        expect(stored).toEqual(retried);
        expect(stored).toMatchObject({ attempts: 2, tokenUsage: usage, costEstimate: 0.003 });
      });

      it("rejects duplicates, missing tasks, and invalid input", async () => {
        const task = {
          id: "task-1",
          caseId: "case-1",
          title: "Analyse",
          assignedRole: "case-analysis",
        } as const;

        await store.tasks.createTaskAsync(task);

        await expect(store.tasks.createTaskAsync(task)).rejects.toThrow(StoreConflictError);
        await expect(
          store.tasks.updateTaskAsync("case-1", "missing", { status: "completed" }),
        ).rejects.toThrow(StoreNotFoundError);
        await expect(
          store.tasks.createTaskAsync({
            ...task,
            id: "task-2",
            assignedRole: "astrologer" as "coordinator",
          }),
        ).rejects.toThrow();
      });
    });

    describe("findings and open questions", () => {
      beforeEach(async () => {
        await store.findings.addFindingAsync("case-1", {
          id: "finding-1",
          taskId: "task-1",
          summary: "Ledger incomplete",
          severity: "medium",
          confidence: "low",
          openQuestions: [
            { id: "q-1", text: "Provide the March ledger", severity: "high" },
            { id: "q-2", text: "Confirm the GSTIN", severity: "low" },
          ],
        });
        await store.findings.addFindingAsync("case-1", {
          id: "finding-2",
          taskId: "task-1",
          summary: "Interest computed",
          openQuestions: [{ id: "q-3", text: "Which rate applies?", severity: "medium" }],
        });
      });

      it("reads findings back with defaults", async () => {
        const findings = await store.findings.getFindingsForCaseAsync("case-1");

        expect(findings.map((finding) => finding.id)).toEqual(["finding-1", "finding-2"]);
        expect(findings[1]).toMatchObject({ evidence: [], assumptions: [] });
        expect(findings[0]?.openQuestions.map((question) => question.status)).toEqual([
          "open",
          "open",
        ]);
      });

      it("resolves, dismisses, and reopens questions by id", async () => {
        const resolved = await store.findings.updateOpenQuestionAsync("case-1", "q-1", {
          status: "resolved",
          resolutionNote: "Ledger uploaded",
        });
        const dismissed = await store.findings.updateOpenQuestionAsync("case-1", "q-3", {
          status: "dismissed",
        });

        expect(resolved.id).toBe("finding-1");
        expect(resolved.openQuestions[0]).toMatchObject({
          status: "resolved",
          resolutionNote: "Ledger uploaded",
          resolvedAt: expect.any(String),
        });
        expect(resolved.openQuestions[1]?.status).toBe("open");
        expect(dismissed.id).toBe("finding-2");
        expect(dismissed.openQuestions[0]?.status).toBe("dismissed");

        const reopened = await store.findings.updateOpenQuestionAsync("case-1", "q-1", {
          status: "open",
        });

        expect(reopened.openQuestions[0]?.status).toBe("open");
        expect(reopened.openQuestions[0]?.resolvedAt).toBeUndefined();
        expect(await store.findings.getFindingsForCaseAsync("case-1")).toEqual([
          reopened,
          dismissed,
        ]);
      });

      it("throws not found for an unknown question", async () => {
        await expect(
          store.findings.updateOpenQuestionAsync("case-1", "q-404", { status: "resolved" }),
        ).rejects.toThrow(StoreNotFoundError);
      });
    });

    describe("evidence", () => {
      it("round-trips structured locations", async () => {
        const input = {
          id: "ev-1",
          sourceRef: "26AS p.2",
          description: "TDS credit",
          documentId: "doc-1",
          confidence: "medium",
          location: {
            page: 2,
            bbox: { x: 0.1, y: 0.4, width: 0.3, height: 0.05 },
            textQuote: "Total TDS 12,000",
          },
        } as const;

        const saved = await store.evidence.addEvidenceAsync("case-1", input);
        await store.evidence.addEvidenceAsync("case-1", {
          id: "ev-0",
          sourceRef: "Ledger",
          description: "Ledger",
          location: { sheet: "Ledger", cellRange: "B2:B9", rowRange: { start: 2, end: 9 } },
        });

        const evidence = await store.evidence.getEvidenceForCaseAsync("case-1");

        expect(saved).toEqual(input);
        expect(evidence.map((item) => item.id)).toEqual(["ev-1", "ev-0"]);
        expect(evidence[0]).toEqual(input);
        await expect(store.evidence.addEvidenceAsync("case-1", input)).rejects.toThrow(
          StoreConflictError,
        );
      });
    });

    describe("deliverables and sections", () => {
      beforeEach(async () => {
        await store.deliverables.saveDeliverableAsync({
          id: "del-1",
          caseId: "case-1",
          title: "Response",
          format: "document",
          sections: [
            {
              id: "sec-1",
              title: "Summary",
              kind: "text",
              content: "Agent summary",
              producedByRole: "response-preparation",
              modelTier: "mid",
            },
            {
              id: "sec-2",
              title: "Reconciliation",
              kind: "table",
              content: '{"rows":[]}',
              producedByRole: "reconciliation",
            },
          ],
        });
      });

      it("edits, reviews, and clears sections individually", async () => {
        const edited = await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          editedContent: "Reviewer summary",
          reviewStatus: "needs-changes",
          reviewComment: "Cite the notice date",
        });

        expect(edited.sections[0]).toMatchObject({
          content: "Agent summary",
          editedContent: "Reviewer summary",
          editedAt: expect.any(String),
          reviewStatus: "needs-changes",
          reviewComment: "Cite the notice date",
          reviewedAt: expect.any(String),
        });
        expect(edited.sections[1]).toMatchObject({ reviewStatus: "pending" });

        const cleared = await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          editedContent: null,
          reviewComment: null,
          reviewStatus: "approved",
        });

        expect(cleared.sections[0]?.editedContent).toBeUndefined();
        expect(cleared.sections[0]?.editedAt).toBeUndefined();
        expect(cleared.sections[0]?.reviewComment).toBeUndefined();
        expect(cleared.sections[0]?.reviewStatus).toBe("approved");
        expect(await store.deliverables.getDeliverableAsync("case-1", "del-1")).toEqual(cleared);
      });

      it("upserts deliverables in place", async () => {
        await store.deliverables.saveDeliverableAsync({
          id: "del-2",
          caseId: "case-1",
          title: "Dashboard",
          format: "dashboard",
        });
        await store.deliverables.saveDeliverableAsync({
          id: "del-1",
          caseId: "case-1",
          title: "Response v2",
          format: "document",
        });

        const deliverables = await store.deliverables.getDeliverablesForCaseAsync("case-1");

        expect(deliverables.map((item) => [item.id, item.title])).toEqual([
          ["del-1", "Response v2"],
          ["del-2", "Dashboard"],
        ]);
        expect(deliverables[0]?.sections).toEqual([]);
        expect(await store.deliverables.getDeliverableAsync("case-1", "missing")).toBeUndefined();
      });

      it("clears case approval when section content is edited or restored", async () => {
        await store.cases.createCaseAsync({ id: "case-1", title: "Review" });
        await store.cases.recordApprovalAsync("case-1", { note: "Original approved" });
        await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          reviewComment: "A comment does not change content",
        });

        expect((await store.cases.getCaseAsync("case-1"))?.approval).toBeDefined();

        await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          editedContent: "Replacement",
        });

        expect((await store.cases.getCaseAsync("case-1"))?.approval).toBeUndefined();

        await store.cases.recordApprovalAsync("case-1", { note: "Replacement approved" });
        await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          editedContent: null,
        });

        expect((await store.cases.getCaseAsync("case-1"))?.approval).toBeUndefined();
      });

      it("updates a deliverable atomically from its latest state", async () => {
        await store.deliverables.updateSectionAsync("case-1", "del-1", "sec-1", {
          editedContent: "Reviewer summary",
        });

        const updated = await store.deliverables.updateDeliverableAsync(
          "case-1",
          "del-1",
          (current) =>
            current && {
              ...current,
              sections: current.sections.map((section) =>
                section.id === "sec-2" ? { ...section, content: '{"rows":[1]}' } : section,
              ),
            },
        );
        const created = await store.deliverables.updateDeliverableAsync(
          "case-1",
          "del-new",
          (current) =>
            current ?? { id: "del-new", caseId: "case-1", title: "New", format: "report" },
        );
        const unchanged = await store.deliverables.updateDeliverableAsync(
          "case-1",
          "del-1",
          () => undefined,
        );

        expect(
          updated?.sections.map((section) => section.editedContent ?? section.content),
        ).toEqual(["Reviewer summary", '{"rows":[1]}']);
        expect(created).toMatchObject({ id: "del-new", sections: [] });
        expect(unchanged).toEqual(updated);
        expect(
          (await store.deliverables.getDeliverablesForCaseAsync("case-1")).map((item) => item.id),
        ).toEqual(["del-1", "del-new"]);
        await expect(
          store.deliverables.updateDeliverableAsync("case-1", "del-1", (current) =>
            current ? { ...current, id: "del-other" } : undefined,
          ),
        ).rejects.toThrow(/must keep/);
      });

      it("throws not found for an unknown deliverable or section", async () => {
        await expect(
          store.deliverables.updateSectionAsync("case-1", "del-1", "sec-404", {
            reviewStatus: "approved",
          }),
        ).rejects.toThrow(StoreNotFoundError);
        await expect(
          store.deliverables.updateSectionAsync("case-1", "del-404", "sec-1", {
            reviewStatus: "approved",
          }),
        ).rejects.toThrow(StoreNotFoundError);
      });
    });

    describe("documents and extraction caching", () => {
      it("stores document metadata", async () => {
        const metadata = {
          id: "doc-1",
          caseId: "case-1",
          name: "ledger.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 4096,
          gcsPath: "gs://bucket/cases/case-1/documents/doc-1/ledger.xlsx",
          uploadedAt: "2026-10-16T00:00:00.000Z",
        };

        await store.documents.addDocumentMetadataAsync(metadata);

        expect(await store.documents.getDocumentsForCaseAsync("case-1")).toEqual([metadata]);
        expect(await store.documents.getDocumentAsync("case-1", "doc-1")).toEqual(metadata);
        expect(await store.documents.getDocumentAsync("case-1", "doc-2")).toBeUndefined();
        await expect(store.documents.addDocumentMetadataAsync(metadata)).rejects.toThrow(
          StoreConflictError,
        );
      });

      it("caches and replaces extractions, including nested table rows", async () => {
        expect(await store.documents.getExtractionAsync("case-1", "doc-1")).toBeUndefined();

        const saved = await store.documents.saveExtractionAsync("case-1", extractionInput("doc-1"));

        expect(await store.documents.getExtractionAsync("case-1", "doc-1")).toEqual(saved);
        expect(saved.tables[0]?.rows).toEqual([
          ["INV-1", 1200],
          ["INV-2", null],
        ]);

        const replaced = await store.documents.saveExtractionAsync(
          "case-1",
          extractionInput("doc-1", "Second pass"),
        );

        expect(await store.documents.getExtractionAsync("case-1", "doc-1")).toEqual(replaced);
        expect(replaced.pages[0]?.text).toBe("Second pass");
      });

      it("round-trips a large extraction", async () => {
        const longText = "Ledger line ₹ 1,200 😀 ".repeat(40_000);
        const saved = await store.documents.saveExtractionAsync(
          "case-1",
          extractionInput("doc-big", longText),
        );
        const fetched = await store.documents.getExtractionAsync("case-1", "doc-big");

        expect(fetched?.pages[0]?.text).toHaveLength(longText.length);
        expect(fetched).toEqual(saved);

        const shrunk = await store.documents.saveExtractionAsync(
          "case-1",
          extractionInput("doc-big", "short"),
        );

        expect(await store.documents.getExtractionAsync("case-1", "doc-big")).toEqual(shrunk);
      });

      it("publishes exactly one complete extraction under concurrent saves", async () => {
        const texts = ["first", "second", "third", "fourth"].map((label) =>
          `${label} `.repeat(70_000),
        );

        await Promise.all(
          texts.map((text) =>
            store.documents.saveExtractionAsync("case-1", extractionInput("doc-race", text)),
          ),
        );

        const fetched = await store.documents.getExtractionAsync("case-1", "doc-race");

        expect(texts).toContain(fetched?.pages[0]?.text);
      });

      it("keeps reads consistent while an extraction is replaced", async () => {
        await store.documents.saveExtractionAsync(
          "case-1",
          extractionInput("doc-live", "v0 ".repeat(90_000)),
        );

        const writes = (async () => {
          for (let round = 1; round <= 4; round += 1) {
            await store.documents.saveExtractionAsync(
              "case-1",
              extractionInput("doc-live", `v${round} `.repeat(90_000)),
            );
          }
        })();
        const reads = (async () => {
          const texts: string[] = [];

          for (let round = 0; round < 8; round += 1) {
            const fetched = await store.documents.getExtractionAsync("case-1", "doc-live");

            texts.push(fetched?.pages[0]?.text ?? "");
          }

          return texts;
        })();

        const [, texts] = await Promise.all([writes, reads]);

        for (const text of texts) {
          expect(text).toMatch(/^v\d /);
        }
      });
    });

    describe("run events", () => {
      it("assigns increasing seq numbers per case and lists after a seq", async () => {
        const first = await store.events.appendEventAsync("case-1", runStarted());
        const second = await store.events.appendEventAsync("case-1", {
          type: "task-started",
          runId: "run-1",
          taskId: "task-1",
          title: "Analyse",
          assignedRole: "case-analysis",
          attempt: 1,
          timestamp: "2026-10-16T00:00:01.000Z",
        });
        const third = await store.events.appendEventAsync("case-1", {
          type: "task-failed",
          runId: "run-1",
          taskId: "task-1",
          error: "Timed out",
        });
        const otherCase = await store.events.appendEventAsync("case-2", runStarted());

        expect([first.seq, second.seq, third.seq, otherCase.seq]).toEqual([1, 2, 3, 1]);
        expect(first).toMatchObject({ caseId: "case-1", timestamp: expect.any(String) });
        expect(second.timestamp).toBe("2026-10-16T00:00:01.000Z");
        expect(third).toMatchObject({ blockedTaskIds: [] });
        expect(await store.events.listEventsAsync("case-1")).toEqual([first, second, third]);
        expect(await store.events.listEventsAsync("case-1", 1)).toEqual([second, third]);
        expect(await store.events.listEventsAsync("case-1", 3)).toEqual([]);
      });

      it("keeps seq unique under concurrent appends", async () => {
        await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            store.events.appendEventAsync("case-1", runStarted(`run-${index}`)),
          ),
        );

        const events = await store.events.listEventsAsync("case-1");

        expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(new Set(events.map((event) => event.runId)).size).toBe(5);
      });

      it("rejects an invalid event", async () => {
        await expect(
          store.events.appendEventAsync("case-1", {
            type: "task-failed",
            runId: "run-1",
          } as unknown as NewRunEvent),
        ).rejects.toThrow();
        expect(await store.events.listEventsAsync("case-1")).toEqual([]);
      });
    });

    describe("document store", () => {
      it("uploads bytes, reads them back, and persists metadata", async () => {
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
        const gcsPath = await documentStore.uploadAsync(
          "case-1",
          "Notice 143(1) déjà final.pdf",
          "application/pdf",
          bytes,
        );
        const metadata = await store.documents.addDocumentMetadataAsync({
          id: "doc-1",
          caseId: "case-1",
          name: "Notice 143(1) déjà final.pdf",
          mimeType: "application/pdf",
          size: bytes.length,
          gcsPath,
          uploadedAt: new Date().toISOString(),
        });

        const read = await documentStore.readBufferAsync(metadata.gcsPath);
        const url = await documentStore.getSignedUrlAsync(gcsPath);

        expect(gcsPath).toMatch(/\/cases\/case-1\/documents\/[^/]+\/Notice_143_1_deja_final\.pdf$/);
        expect(Buffer.compare(read, bytes)).toBe(0);
        expect(url.length).toBeGreaterThan(0);
        expect((await store.documents.getDocumentAsync("case-1", "doc-1"))?.gcsPath).toBe(gcsPath);
      });

      it("keeps separate uploads of the same file name apart", async () => {
        const first = await documentStore.uploadAsync(
          "case-1",
          "a.txt",
          "text/plain",
          Buffer.from("1"),
        );
        const second = await documentStore.uploadAsync(
          "case-1",
          "a.txt",
          "text/plain",
          Buffer.from("2"),
        );

        expect(first).not.toBe(second);
        expect((await documentStore.readBufferAsync(first)).toString()).toBe("1");
        expect((await documentStore.readBufferAsync(second)).toString()).toBe("2");
      });

      it("throws not found for a missing file", async () => {
        const path = await documentStore.uploadAsync(
          "case-1",
          "a.txt",
          "text/plain",
          Buffer.from("1"),
        );
        const missing = path.replace(/a\.txt$/, "missing.txt");

        await expect(documentStore.readBufferAsync(missing)).rejects.toThrow(StoreNotFoundError);
      });
    });
  });
}
