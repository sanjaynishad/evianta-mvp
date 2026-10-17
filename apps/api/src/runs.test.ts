import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { DocumentsUnavailableError } from "./ingestion.js";
import { createApp } from "./app.js";
import { silentApiLogger } from "./logger.js";
import { asText, createTestHarness, sseFramesOf, VISITOR_A } from "./testing/harness.js";

describe("run preflight errors", () => {
  it("keeps unexpected preflight diagnostics out of SSE and case state", async () => {
    const { store, documentStore, ai, orchestrator } = createTestHarness();
    const diagnostic =
      "Permission denied: projects/private-project/buckets/internal-path token=secret";
    const warn = vi.fn();
    const app = createApp({
      store,
      documentStore,
      ai,
      orchestrator,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const caseRecord = await store.cases.createCaseAsync({
      title: "Preflight",
      useCase: "data-analysis",
    });
    const getDocumentsAsync = store.documents.getDocumentsForCaseAsync.bind(store.documents);

    store.documents.getDocumentsForCaseAsync = async () => {
      throw new Error(diagnostic);
    };

    await request(app).post(`/cases/${caseRecord.id}/run`).expect(202);
    await app.idleAsync();
    store.documents.getDocumentsForCaseAsync = getDocumentsAsync;

    const stream = await asText(request(app).get(`/cases/${caseRecord.id}/stream`)).expect(200);
    const state = await request(app).get(`/cases/${caseRecord.id}`).expect(200);
    const message = "The run could not finish. Try again.";

    expect(sseFramesOf(stream)).toEqual([
      expect.objectContaining({
        event: "run-failed",
        data: expect.objectContaining({ error: message }),
      }),
    ]);
    expect(state.body.run.lastRunError).toBe(message);
    expect(JSON.stringify([stream.body, state.body])).not.toContain(diagnostic);
    expect(warn).toHaveBeenCalledWith(
      "Run could not finish.",
      expect.objectContaining({ error: diagnostic }),
    );
  });

  it("preserves explicitly safe document-unavailable guidance", async () => {
    const { store, documentStore, ai, orchestrator } = createTestHarness();
    const error = new DocumentsUnavailableError([{ id: "doc-1", name: "sales.csv" }]);
    const app = createApp({ store, documentStore, ai, orchestrator, logger: silentApiLogger });
    const caseRecord = await store.cases.createCaseAsync({
      title: "Preflight",
      useCase: "data-analysis",
    });

    store.documents.getDocumentsForCaseAsync = async () => {
      throw error;
    };

    await request(app).post(`/cases/${caseRecord.id}/run`).expect(202);
    await app.idleAsync();

    const events = await store.events.listEventsAsync(caseRecord.id);

    expect(events.at(-1)).toMatchObject({ type: "run-failed", error: error.message });
  });

  it("sanitizes persisted run errors in case state and replayed SSE", async () => {
    const { app, store } = createTestHarness();
    const diagnostic = "Permission denied: projects/private-project token=secret";
    const caseRecord = await store.cases.createCaseAsync({
      title: "Persisted failure",
      useCase: "data-analysis",
      visitorId: VISITOR_A,
    });
    await store.tasks.createTaskAsync({
      id: "failed-task",
      caseId: caseRecord.id,
      title: "Private task",
      assignedRole: "business-data-analyst",
      status: "failed",
      attempts: 1,
      lastError: diagnostic,
    });
    await store.events.appendEventAsync(caseRecord.id, {
      type: "task-failed",
      runId: "run-with-diagnostic",
      taskId: "failed-task",
      error: diagnostic,
    });

    await store.events.appendEventAsync(caseRecord.id, {
      type: "run-failed",
      runId: "run-with-diagnostic",
      error: diagnostic,
      failedTaskIds: [],
    });

    const stream = await asText(request(app).get(`/cases/${caseRecord.id}/stream`)).expect(200);
    const state = await request(app).get(`/cases/${caseRecord.id}`).expect(200);
    const message = "The run could not finish. Try again.";
    const taskMessage = "The task could not finish. Review the case inputs and try again.";

    expect(sseFramesOf(stream)).toEqual([
      expect.objectContaining({
        event: "task-failed",
        data: expect.objectContaining({ error: taskMessage }),
      }),
      expect.objectContaining({
        event: "run-failed",
        data: expect.objectContaining({ error: message }),
      }),
    ]);
    expect(state.body.run.lastRunError).toBe(message);
    expect(state.body.tasks[0].lastError).toBe(taskMessage);
    expect(JSON.stringify([stream.body, state.body])).not.toContain(diagnostic);
  });
});
