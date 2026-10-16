import {
  createDefaultTaskHandlers,
  createSpecialistAgent,
  createSpecialistTaskHandler,
  type TaskHandler,
} from "@evianta/agents";
import {
  DocumentExtractionError,
  OcrConfigurationError,
  OcrExtractionError,
} from "@evianta/ingest";
import { createInMemoryStore } from "@evianta/store";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  asText,
  closeServerAsync,
  createTestHarness,
  finding,
  listenAsync,
  openLiveSse,
  SALES_CSV,
  specialistStep,
  sseFramesOf,
  VISITOR_A,
  waitForAsync,
  type SseFrame,
} from "./testing/harness.js";

function idsOf(frames: readonly SseFrame[]): number[] {
  return frames.map((frame) => Number(frame.id));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

async function createCaseAsync(app: Parameters<typeof request>[0], useCase = "data-analysis") {
  const response = await request(app)
    .post("/cases")
    .set("X-Evianta-Visitor", VISITOR_A)
    .send({ title: "Quarterly sales review", description: "Q1 trends", useCase })
    .expect(201);

  return response.body.id as string;
}

// These tests cover the HTTP lifecycle, so they pin the generic specialist instead of the
// spreadsheet-driven data analyst; dataAnalysis.test.ts covers that flow.
function genericAnalystHandlers() {
  return createDefaultTaskHandlers().register(
    createSpecialistTaskHandler(createSpecialistAgent("business-data-analyst")),
  );
}

function gatedAnalystHandler(): { handler: TaskHandler; release: () => void } {
  let release: () => void = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    handler: {
      role: "business-data-analyst",
      async executeAsync() {
        await gate;

        return {
          findings: [finding("Revenue peaked in March")],
          usage: { input: 400, output: 100, total: 500 },
          cost: 0.0002,
          modelTier: "cheap",
        };
      },
    },
  };
}

describe("case lifecycle over HTTP", () => {
  it("creates a case, uploads a CSV, runs it, streams to a terminal event, and serves the deliverable", async () => {
    const { app, ai } = createTestHarness({ handlers: genericAnalystHandlers() });
    const caseId = await createCaseAsync(app);
    const upload = await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", Buffer.from(SALES_CSV), { filename: "sales.csv", contentType: "text/csv" })
      .expect(201);
    const [uploaded] = upload.body.documents;

    expect(uploaded).toMatchObject({ caseId, name: "sales.csv", mimeType: "text/csv" });
    expect(uploaded).not.toHaveProperty("gcsPath");
    expect(["processing", "ready"]).toContain(uploaded.status);

    await app.idleAsync();

    const afterUpload = await request(app).get(`/cases/${caseId}`).expect(200);

    expect(afterUpload.body.documents[0]).toMatchObject({
      status: "ready",
      extraction: { kind: "tabular", method: "parse", pagesNeedingReview: [] },
    });

    ai.script(
      "business-data-analyst",
      specialistStep(
        [
          finding("March revenue peaked at 143,000", {
            evidence: [{ documentId: uploaded.id, description: "March row", rowStart: 4 }],
          }),
        ],
        { title: "Revenue trend", content: "Revenue peaked in March at 143,000." },
      ),
    );

    const run = await request(app).post(`/cases/${caseId}/run`).expect(202);

    expect(run.body).toEqual({
      caseId,
      runId: expect.any(String),
      mode: "run",
      streamUrl: `/cases/${caseId}/stream`,
    });

    const stream = await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200);
    const frames = sseFramesOf(stream);

    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.headers["cache-control"]).toContain("no-cache");
    expect(idsOf(frames)).toEqual(range(1, frames.length));
    expect(frames.map((frame) => frame.event)).toEqual(
      expect.arrayContaining(["run-started", "task-started", "finding-added", "task-completed"]),
    );
    expect(frames.at(-1)).toMatchObject({
      event: "run-completed",
      data: { type: "run-completed", deliverableIds: ["deliverable-primary"] },
    });
    expect(
      frames.every((frame) => (frame.data as { runId: string }).runId === run.body.runId),
    ).toBe(true);

    const state = await request(app).get(`/cases/${caseId}`).expect(200);

    expect(state.body.case).toMatchObject({ id: caseId, status: "completed" });
    expect(state.body.tasks).toHaveLength(1);
    expect(state.body.findings.map((item: { summary: string }) => item.summary)).toContain(
      "March revenue peaked at 143,000",
    );
    expect(state.body.evidence).toEqual([
      expect.objectContaining({ documentId: uploaded.id, sourceRef: "sales.csv row 4" }),
    ]);
    expect(state.body.cost.costEstimate).toBeGreaterThan(0);
    expect(state.body.cost.runCount).toBe(1);
    expect(state.body.run).toMatchObject({
      active: false,
      lastEventSeq: frames.length,
      lastRunId: run.body.runId,
      lastEventType: "run-completed",
      lastRunMode: "run",
    });

    const deliverable = await request(app)
      .get(`/cases/${caseId}/deliverables/deliverable-primary`)
      .expect(200);

    expect(deliverable.body.sections).toEqual([
      expect.objectContaining({
        title: "Revenue trend",
        content: "Revenue peaked in March at 143,000.",
        producedByRole: "business-data-analyst",
      }),
    ]);

    const afterPlanning = await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", Buffer.from(SALES_CSV), { filename: "q2.csv", contentType: "text/csv" })
      .expect(409);

    expect(afterPlanning.body).toMatchObject({ error: "case-already-planned" });

    const replay = await asText(
      request(app)
        .get(`/cases/${caseId}/stream`)
        .query({ after: frames.length - 2 }),
    ).expect(200);

    expect(idsOf(sseFramesOf(replay))).toEqual([frames.length - 1, frames.length]);
  });

  it("rejects a second run while one is active and resumes a stream without gaps or duplicates", async () => {
    const gated = gatedAnalystHandler();
    const handlers = createDefaultTaskHandlers().register(gated.handler);
    const { app } = createTestHarness({ handlers });
    const caseId = await createCaseAsync(app);
    const { baseUrl, server } = await listenAsync(app);

    try {
      const run = await request(app).post(`/cases/${caseId}/run`).expect(202);
      const conflict = await request(app).post(`/cases/${caseId}/run`).expect(409);

      expect(conflict.body).toMatchObject({ error: "run-in-progress" });

      const lateUpload = await request(app)
        .post(`/cases/${caseId}/documents`)
        .attach("files", Buffer.from(SALES_CSV), { filename: "late.csv", contentType: "text/csv" })
        .expect(409);

      expect(lateUpload.body).toMatchObject({ error: "run-in-progress" });

      const first = openLiveSse(`${baseUrl}/cases/${caseId}/stream`);
      const received = await first.waitForFramesAsync(2);

      expect(received.map((frame) => frame.event)).toEqual(["run-started", "task-started"]);

      await waitForAsync(() => first.comments.includes("heartbeat"));
      first.close();
      await first.ended;

      const second = openLiveSse(`${baseUrl}/cases/${caseId}/stream`, {
        "Last-Event-ID": String(received.at(-1)?.id),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(second.frames).toEqual([]);

      gated.release();
      await second.ended;

      const combined = [...received, ...second.frames];

      expect(idsOf(combined)).toEqual(range(1, combined.length));
      expect(combined.at(-1)).toMatchObject({
        event: "run-completed",
        data: { runId: run.body.runId },
      });
    } finally {
      gated.release();
      await app.idleAsync();
      await closeServerAsync(server);
    }
  });

  it("closes a stream for a finished run after replaying it and stays open for a new run", async () => {
    const { app, ai } = createTestHarness({ handlers: genericAnalystHandlers() });
    const caseId = await createCaseAsync(app);

    ai.script("business-data-analyst", specialistStep([finding("First pass")]));
    await request(app).post(`/cases/${caseId}/run`).expect(202);
    await app.idleAsync();

    const finished = await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200);
    const firstRun = sseFramesOf(finished);

    expect(firstRun.at(-1)?.event).toBe("run-completed");

    const second = await request(app).post(`/cases/${caseId}/run`).expect(202);
    const resumed = await asText(
      request(app).get(`/cases/${caseId}/stream`).set("Last-Event-ID", String(firstRun.length)),
    ).expect(200);
    const secondRun = sseFramesOf(resumed);

    expect(idsOf(secondRun)).toEqual(
      range(firstRun.length + 1, firstRun.length + secondRun.length),
    );
    expect(secondRun[0]).toMatchObject({
      event: "run-started",
      data: { runId: second.body.runId },
    });
    expect(secondRun.at(-1)?.event).toBe("run-completed");
  });

  it("retries only failed and blocked tasks", async () => {
    const { app, ai } = createTestHarness({
      script: {
        "case-analysis": specialistStep([finding("Demand of Rs. 48,210 raised")]),
        reconciliation: [
          { error: "non-transient", message: "Ledger could not be read" },
          specialistStep([finding("TDS mismatch of Rs. 12,400")]),
        ],
        "tax-research": specialistStep([finding("Section 143(1) applies")]),
        "response-preparation": specialistStep([finding("Draft response prepared")]),
        "independent-review": specialistStep([]),
      },
    });
    const caseId = await createCaseAsync(app, "tax-notice");

    await request(app).post(`/cases/${caseId}/run`).expect(202);

    const failedRun = sseFramesOf(
      await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200),
    );

    expect(failedRun.at(-1)).toMatchObject({ event: "run-failed" });

    const before = await request(app).get(`/cases/${caseId}`).expect(200);
    const statusByRole = Object.fromEntries(
      before.body.tasks.map((task: { assignedRole: string; status: string }) => [
        task.assignedRole,
        task.status,
      ]),
    );

    expect(statusByRole).toEqual({
      "case-analysis": "completed",
      reconciliation: "failed",
      "tax-research": "completed",
      "response-preparation": "blocked",
      "independent-review": "blocked",
    });
    expect(before.body.run).toMatchObject({
      lastEventType: "run-failed",
      lastRunMode: "run",
      lastRunError: expect.any(String),
    });

    const callsBefore = ai.calls.length;
    const retry = await request(app).post(`/cases/${caseId}/retry`).expect(202);

    expect(retry.body).toMatchObject({ mode: "retry", runId: expect.any(String) });

    const retryRun = sseFramesOf(
      await asText(
        request(app).get(`/cases/${caseId}/stream`).query({ after: failedRun.length }),
      ).expect(200),
    );

    expect(retryRun[0]).toMatchObject({ event: "run-started", data: { mode: "retry" } });
    expect(retryRun.at(-1)).toMatchObject({ event: "run-completed" });
    expect(ai.calls.slice(callsBefore).map((call) => call.key)).toEqual([
      "reconciliation",
      "response-preparation",
      "independent-review",
    ]);

    const nothingLeft = await request(app).post(`/cases/${caseId}/retry`).expect(409);

    expect(nothingLeft.body).toMatchObject({ error: "nothing-to-retry" });
  });

  it("records extraction usage and failures from ingestion", async () => {
    let calls = 0;
    const { app } = createTestHarness({
      async ingest({ caseId, document, store }) {
        calls += 1;

        if (document.name === "broken.pdf") {
          throw new Error("disk exploded at /var/secret");
        }

        const extraction = await store.documents.saveExtractionAsync(caseId, {
          documentId: document.id,
          kind: "text",
          method: "handwriting",
          confidence: 0.55,
          pages: [
            { index: 1, text: "Received Rs. 10,000", method: "handwriting", confidence: 0.55 },
          ],
          warnings: ["Handwriting detected on page 1."],
        });

        return {
          extraction,
          usage: { input: 900, output: 120, total: 1020 },
          cost: 0.0004,
          pageUsage: [],
          failedPages: [],
          cached: false,
        };
      },
    });
    const caseId = await createCaseAsync(app);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");

    await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", pdf, { filename: "receipt.pdf", contentType: "application/pdf" })
      .attach("files", pdf, { filename: "broken.pdf", contentType: "application/pdf" })
      .expect(201);
    await app.idleAsync();

    const state = await request(app).get(`/cases/${caseId}`).expect(200);
    const byName = Object.fromEntries(
      state.body.documents.map((document: { name: string }) => [document.name, document]),
    );

    expect(calls).toBe(2);
    expect(byName["receipt.pdf"]).toMatchObject({
      status: "ready",
      extraction: {
        method: "handwriting",
        confidence: 0.55,
        warnings: ["Handwriting detected on page 1."],
        pagesNeedingReview: [1],
        handwriting: true,
      },
    });
    expect(byName["broken.pdf"]).toMatchObject({ status: "failed", errorCode: "read-failed" });
    expect(byName["broken.pdf"].error).not.toContain("/var/secret");
    expect(state.body.case.usage).toMatchObject({
      inputTokens: 900,
      outputTokens: 120,
      costEstimate: 0.0004,
    });

    const detail = await request(app)
      .get(`/cases/${caseId}/documents/${byName["receipt.pdf"].id}`)
      .expect(200);

    expect(detail.body.extraction.pages[0].text).toBe("Received Rs. 10,000");

    const file = await request(app)
      .get(`/cases/${caseId}/documents/${byName["receipt.pdf"].id}/file`)
      .expect(200);

    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toContain('inline; filename="receipt.pdf"');
  });

  it("returns client-safe document errors without provider or parser diagnostics", async () => {
    const providerDetail =
      "PERMISSION_DENIED: API key AIzaSy-secret-key for project evianta-prod-123 at https://aiplatform.googleapis.com/v1/internal";
    const accounting = {
      usage: { input: 258, output: 0, total: 258 },
      cost: 0.0001,
      pageUsage: [],
    };
    const { app } = createTestHarness({
      async ingest({ document }) {
        if (document.name === "config.pdf") {
          throw new OcrConfigurationError(document.id, accounting, [new Error(providerDetail)]);
        }

        if (document.name === "ocr.pdf") {
          throw new OcrExtractionError(document.id, accounting, [new Error(providerDetail)]);
        }

        if (document.name === "partial.pdf") {
          return {
            extraction: {
              documentId: document.id,
              kind: "text",
              method: "mixed",
              confidence: 0.5,
              pages: [
                { index: 1, text: "Readable page", method: "pdf-text", confidence: 0.99 },
                { index: 2, text: "", method: "ocr", confidence: 0 },
              ],
              tables: [],
              warnings: [
                `Page 2: extraction failed (${providerDetail}); the page content is missing.`,
              ],
            },
            ...accounting,
            failedPages: [2],
            cached: false,
          };
        }

        throw new DocumentExtractionError(
          document.id,
          `"${document.name}" could not be read as a PDF: ${providerDetail}`,
        );
      },
    });
    const caseId = await createCaseAsync(app);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");

    await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", pdf, { filename: "config.pdf", contentType: "application/pdf" })
      .attach("files", pdf, { filename: "ocr.pdf", contentType: "application/pdf" })
      .attach("files", pdf, { filename: "parser.pdf", contentType: "application/pdf" })
      .attach("files", pdf, { filename: "partial.pdf", contentType: "application/pdf" })
      .expect(201);
    await app.idleAsync();

    const state = await request(app).get(`/cases/${caseId}`).expect(200);
    const codes = Object.fromEntries(
      state.body.documents.map((document: { name: string; errorCode: string }) => [
        document.name,
        document.errorCode,
      ]),
    );
    const partial = state.body.documents.find(
      (document: { name: string }) => document.name === "partial.pdf",
    );
    const detail = await request(app).get(`/cases/${caseId}/documents/${partial.id}`).expect(200);

    await request(app).post(`/cases/${caseId}/run`).expect(202);

    const stream = await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200);
    const after = await request(app).get(`/cases/${caseId}`).expect(200);

    expect(codes).toEqual({
      "config.pdf": "ocr-unavailable",
      "ocr.pdf": "ocr-failed",
      "parser.pdf": "extraction-failed",
      "partial.pdf": "ocr-partial",
    });
    expect(partial).toMatchObject({ status: "partial" });
    expect(detail.body.extraction.warnings).toEqual([
      "Page 2: text recognition failed; the page content is missing.",
    ]);
    expect(detail.body.extraction.pages[0].text).toBe("Readable page");
    expect(state.body.case.usage.inputTokens).toBe(774);
    expect(sseFramesOf(stream).at(-1)?.event).toBe("run-failed");
    expect(after.body.run).toMatchObject({ lastEventType: "run-failed" });
    expect(after.body.run.lastRunMode).toBeUndefined();
    expect(after.body.run.lastRunError).toContain('"config.pdf"');

    for (const body of [state.text, detail.text, stream.body as string, after.text]) {
      for (const secret of ["PERMISSION_DENIED", "AIzaSy", "evianta-prod-123", "googleapis"]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("does not start a run while a document is unread for a retryable reason", async () => {
    let ocrAvailable = false;
    const { app, ai } = createTestHarness({
      handlers: genericAnalystHandlers(),
      async ingest({ caseId, document, store }) {
        if (document.name === "corrupt.xlsx") {
          throw new DocumentExtractionError(document.id, "The workbook is damaged.");
        }

        if (!ocrAvailable) {
          throw new Error("OCR service unavailable");
        }

        const extraction = await store.documents.saveExtractionAsync(caseId, {
          documentId: document.id,
          kind: "text",
          method: "ocr",
          confidence: 0.9,
          pages: [{ index: 1, text: "Notice text", method: "ocr", confidence: 0.9 }],
        });

        return {
          extraction,
          usage: { input: 0, output: 0, total: 0 },
          cost: 0,
          pageUsage: [],
          failedPages: [],
          cached: false,
        };
      },
    });
    const caseId = await createCaseAsync(app);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
    const xlsx = Buffer.from("PK\u0003\u0004 xl/workbook.xml", "latin1");

    await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", pdf, { filename: "scan.pdf", contentType: "application/pdf" })
      .attach("files", xlsx, {
        filename: "corrupt.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      .expect(201);
    await app.idleAsync();

    const blocked = await request(app).post(`/cases/${caseId}/run`).expect(202);
    const blockedFrames = sseFramesOf(
      await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200),
    );

    expect(blockedFrames).toEqual([
      expect.objectContaining({
        event: "run-failed",
        data: expect.objectContaining({ runId: blocked.body.runId }),
      }),
    ]);
    expect((blockedFrames[0]?.data as { error: string }).error).toContain('"scan.pdf"');
    expect((blockedFrames[0]?.data as { error: string }).error).not.toContain("corrupt.xlsx");

    ocrAvailable = true;
    ai.script("business-data-analyst", specialistStep([finding("Notice reviewed")]));

    await request(app).post(`/cases/${caseId}/run`).expect(202);

    const completed = sseFramesOf(
      await asText(request(app).get(`/cases/${caseId}/stream`).query({ after: 1 })).expect(200),
    );
    const state = await request(app).get(`/cases/${caseId}`).expect(200);

    expect(completed.at(-1)?.event).toBe("run-completed");
    expect(
      Object.fromEntries(
        state.body.documents.map((document: { name: string; status: string }) => [
          document.name,
          document.status,
        ]),
      ),
    ).toEqual({ "scan.pdf": "ready", "corrupt.xlsx": "failed" });
  });

  it("records a terminal event when the orchestrator could not store its own", async () => {
    const store = createInMemoryStore();
    const appendEventAsync = store.events.appendEventAsync.bind(store.events);
    let failedTerminalWrites = 0;

    store.events.appendEventAsync = async (caseId, event) => {
      if (
        (event.type === "run-completed" || event.type === "run-failed") &&
        failedTerminalWrites === 0
      ) {
        failedTerminalWrites += 1;

        throw new Error("Firestore unavailable");
      }

      return appendEventAsync(caseId, event);
    };

    const { app } = createTestHarness({
      store,
      script: { "business-data-analyst": specialistStep([finding("Done")]) },
    });
    const caseId = await createCaseAsync(app);
    const run = await request(app).post(`/cases/${caseId}/run`).expect(202);
    const frames = sseFramesOf(
      await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200),
    );

    expect(failedTerminalWrites).toBe(1);
    expect(idsOf(frames)).toEqual(range(1, frames.length));
    expect(frames.at(-1)).toMatchObject({
      event: "run-failed",
      data: { runId: run.body.runId },
    });
    expect((frames.at(-1)?.data as { error: string }).error).toBe(
      "The run could not finish. Try again.",
    );
  });
});
