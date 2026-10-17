import { createDefaultTaskHandlers, type TaskHandler } from "@evianta/agents";
import type { AgentRole } from "@evianta/core";
import { createInMemoryDocumentStore, createInMemoryStore } from "@evianta/store";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { loadCaseStateAsync } from "./caseState.js";
import { createIngestionService } from "./ingestion.js";
import { silentApiLogger } from "./logger.js";
import type { RunLauncher } from "./runs.js";
import {
  createTestHarness,
  finding,
  SALES_CSV,
  specialistStep,
  VISITOR_A,
  waitForAsync,
} from "./testing/harness.js";

function createGate() {
  let release: () => void = () => {};

  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { opened, release };
}

function gatedHandler(role: AgentRole, gate: Promise<void>): TaskHandler {
  return {
    role,
    async executeAsync() {
      await gate;

      return {
        findings: [finding(`${role} done`)],
        usage: { input: 100, output: 20, total: 120 },
        cost: 0.0001,
        modelTier: "mid",
      };
    },
  };
}

describe("case state consistency", () => {
  it("reports totals that include every cost event before the cursor during a run", async () => {
    const gate = createGate();
    const handlers = createDefaultTaskHandlers()
      .register(gatedHandler("reconciliation", gate.opened))
      .register(gatedHandler("tax-research", gate.opened));
    const { app, store } = createTestHarness({
      handlers,
      script: { "case-analysis": specialistStep([finding("Demand of Rs. 48,210 raised")]) },
    });
    const created = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "Notice", useCase: "tax-notice" })
      .expect(201);
    const caseId = created.body.id as string;

    try {
      await request(app).post(`/cases/${caseId}/run`).expect(202);
      await waitForAsync(async () => {
        const events = await store.events.listEventsAsync(caseId);

        return events.filter((event) => event.type === "task-started").length === 3;
      });

      const state = await request(app).get(`/cases/${caseId}`).expect(200);
      const seen = (await store.events.listEventsAsync(caseId)).filter(
        (event) => event.seq <= state.body.run.lastEventSeq,
      );
      const latestCost = seen
        .map((event) =>
          event.type === "cost-updated"
            ? event.totalCostEstimate
            : event.type === "task-completed"
              ? event.runningCostEstimate
              : undefined,
        )
        .filter((cost): cost is number => cost !== undefined)
        .at(-1);

      expect(state.body.run.active).toBe(true);
      expect(latestCost).toBeGreaterThan(0);
      expect(state.body.cost.costEstimate).toBeCloseTo(latestCost as number, 10);
    } finally {
      gate.release();
      await app.idleAsync();
    }
  });

  it("samples the active flag after reading the cursor", async () => {
    const store = createInMemoryStore();
    const caseRecord = await store.cases.createCaseAsync({
      title: "Settling run",
      useCase: "data-analysis",
    });

    await store.events.appendEventAsync(caseRecord.id, {
      type: "run-completed",
      runId: "run-1",
      deliverableIds: [],
      totalTokenUsage: { input: 0, output: 0, total: 0 },
      totalCostEstimate: 0,
    });

    let active = true;
    const listEventsAsync = store.events.listEventsAsync.bind(store.events);

    store.events.listEventsAsync = async (caseId, afterSeq) => {
      const events = await listEventsAsync(caseId, afterSeq);

      active = false;

      return events;
    };

    const runs = { isActive: () => active } as unknown as RunLauncher;
    const ingestion = createIngestionService({
      store,
      documentStore: createInMemoryDocumentStore(),
      ai: {} as never,
      ingest: async () => {
        throw new Error("not used");
      },
      logger: silentApiLogger,
    });
    const state = await loadCaseStateAsync(store, ingestion, runs, caseRecord.id);

    expect(state?.run).toMatchObject({
      active: false,
      lastEventSeq: 1,
      lastEventType: "run-completed",
    });
  });

  it("extracts documents stored before a later file in the batch failed", async () => {
    const documentStore = createInMemoryDocumentStore();
    const uploadAsync = documentStore.uploadAsync.bind(documentStore);
    let uploads = 0;

    documentStore.uploadAsync = async (caseId, fileName, mimeType, buffer) => {
      uploads += 1;

      if (uploads === 2) {
        throw new Error("bucket unavailable");
      }

      return uploadAsync(caseId, fileName, mimeType, buffer);
    };

    const { app } = createTestHarness({ documentStore });
    const created = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "Sales", useCase: "data-analysis" })
      .expect(201);
    const caseId = created.body.id as string;

    await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", Buffer.from(SALES_CSV), { filename: "first.csv", contentType: "text/csv" })
      .attach("files", Buffer.from(SALES_CSV), { filename: "second.csv", contentType: "text/csv" })
      .expect(500);
    await app.idleAsync();

    const state = await request(app).get(`/cases/${caseId}`).expect(200);

    expect(state.body.documents).toEqual([
      expect.objectContaining({ name: "first.csv", status: "ready" }),
    ]);
  });

  it("does not admit a run while an approval is being recorded", async () => {
    const gate = createGate();
    const store = createInMemoryStore();
    const getFindingsAsync = store.findings.getFindingsForCaseAsync.bind(store.findings);
    let approvalReading = false;

    store.findings.getFindingsForCaseAsync = async (caseId) => {
      approvalReading = true;
      await gate.opened;

      return getFindingsAsync(caseId);
    };

    const { app } = createTestHarness({
      store,
      script: { "business-data-analyst": specialistStep([finding("Revenue grew")]) },
    });
    const caseRecord = await store.cases.createCaseAsync({
      title: "Review",
      useCase: "data-analysis",
      visitorId: VISITOR_A,
    });
    const approval = request(app)
      .post(`/cases/${caseRecord.id}/approve`)
      .send({ note: "Looks right." })
      .then((response) => response);

    await waitForAsync(() => approvalReading);

    const blocked = await request(app).post(`/cases/${caseRecord.id}/run`).expect(409);

    expect(blocked.body).toMatchObject({ error: "approval-in-progress" });

    gate.release();

    expect((await approval).status).toBe(200);
    await request(app).post(`/cases/${caseRecord.id}/run`).expect(202);
    await app.idleAsync();
  });
});
