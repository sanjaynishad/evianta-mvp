import JSZip from "jszip";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestHarness, finding, waitForAsync } from "./testing/harness.js";

function createGate() {
  let release: () => void = () => {};

  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { opened, release };
}

async function seedAsync() {
  const harness = createTestHarness();
  const caseRecord = await harness.store.cases.createCaseAsync({
    title: "Review",
    useCase: "data-analysis",
    status: "completed",
  });

  await harness.store.deliverables.saveDeliverableAsync({
    id: "report",
    caseId: caseRecord.id,
    title: "Report",
    format: "report",
    sections: [
      {
        id: "summary",
        title: "Summary",
        kind: "text",
        content: "Original content",
        producedByRole: "business-data-analyst",
      },
    ],
  });

  return { ...harness, base: `/cases/${caseRecord.id}`, caseId: caseRecord.id };
}

async function exportedTextAsync(app: ReturnType<typeof createTestHarness>["app"], base: string) {
  const response = await request(app)
    .get(`${base}/deliverables/report/export?format=docx`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const zip = await JSZip.loadAsync(response.body as Buffer);

  return zip.file("word/document.xml")!.async("string");
}

describe("approval and editing consistency", () => {
  it("requires an explicit acknowledgement when the independent review failed", async () => {
    const { app, store, base, caseId } = await seedAsync();

    await store.tasks.createTaskAsync({
      id: "failed-independent-review",
      caseId,
      title: "Independent review",
      assignedRole: "independent-review",
      status: "failed",
      attempts: 1,
    });

    const blocked = await request(app).post(`${base}/approve`).send({}).expect(409);
    expect(blocked.body).toMatchObject({ error: "review-incomplete" });
    expect((await store.cases.getCaseAsync(caseId))?.approval).toBeUndefined();

    const approved = await request(app)
      .post(`${base}/approve`)
      .send({ acknowledgeIncompleteReview: true })
      .expect(200);

    expect(approved.body.case.approval.reviewFailureAcknowledged).toBe(true);
  });

  it("does not export replacement content with the previous approval", async () => {
    const { app, store, base, caseId } = await seedAsync();

    await request(app).post(`${base}/approve`).send({ note: "Original approved" }).expect(200);
    expect(await exportedTextAsync(app, base)).toContain("Approved by the reviewer");

    await request(app)
      .patch(`${base}/deliverables/report/sections/summary`)
      .send({ editedContent: "Replacement content" })
      .expect(200);

    expect((await store.cases.getCaseAsync(caseId))?.approval).toBeUndefined();

    const xml = await exportedTextAsync(app, base);

    expect(xml).toContain("Replacement content");
    expect(xml).not.toContain("Approved by the reviewer");
  });

  it("serializes an edit behind the entire approval write", async () => {
    const { app, store, base, caseId } = await seedAsync();
    const gate = createGate();
    const recordAsync = store.cases.recordApprovalAsync.bind(store.cases);
    const updateAsync = store.deliverables.updateSectionAsync.bind(store.deliverables);
    let writingApproval = false;
    let editing = false;

    store.cases.recordApprovalAsync = async (...args) => {
      writingApproval = true;
      await gate.opened;

      return recordAsync(...args);
    };

    store.deliverables.updateSectionAsync = async (...args) => {
      editing = true;

      return updateAsync(...args);
    };

    const approval = request(app)
      .post(`${base}/approve`)
      .send({})
      .then((res) => res);

    await waitForAsync(() => writingApproval);

    const edit = request(app)
      .patch(`${base}/deliverables/report/sections/summary`)
      .send({ editedContent: "Replacement content" })
      .then((res) => res);

    try {
      await request(app).get(`${base}/deliverables/report`).expect(200);
      expect(editing).toBe(false);
    } finally {
      gate.release();
      await Promise.all([approval, edit]);
    }

    expect((await approval).status).toBe(200);
    expect((await edit).status).toBe(200);
    expect((await store.cases.getCaseAsync(caseId))?.approval).toBeUndefined();
    expect(await exportedTextAsync(app, base)).not.toContain("Approved by the reviewer");
  });

  it("queues approval and export behind an in-flight edit", async () => {
    const { app, store, base, caseId } = await seedAsync();
    const gate = createGate();
    const updateAsync = store.deliverables.updateSectionAsync.bind(store.deliverables);
    const getFindingsAsync = store.findings.getFindingsForCaseAsync.bind(store.findings);
    let editing = false;
    let readingApproval = false;

    await request(app).post(`${base}/approve`).send({ note: "Old approval" }).expect(200);

    store.deliverables.updateSectionAsync = async (...args) => {
      editing = true;
      await gate.opened;

      return updateAsync(...args);
    };

    store.findings.getFindingsForCaseAsync = async (...args) => {
      readingApproval = true;

      return getFindingsAsync(...args);
    };

    const edit = request(app)
      .patch(`${base}/deliverables/report/sections/summary`)
      .send({ editedContent: "Replacement content" })
      .then((res) => res);

    await waitForAsync(() => editing);

    const exportResult = exportedTextAsync(app, base);
    const approval = request(app)
      .post(`${base}/approve`)
      .send({ note: "New approval" })
      .then((res) => res);

    try {
      await request(app).get(`${base}/deliverables/report`).expect(200);
      expect(readingApproval).toBe(false);
    } finally {
      gate.release();
      await Promise.all([edit, exportResult, approval]);
    }

    expect((await edit).status).toBe(200);
    expect((await approval).status).toBe(200);
    expect((await store.cases.getCaseAsync(caseId))?.approval?.note).toBe("New approval");
    expect(await exportResult).toContain("Replacement content");
    expect(await exportResult).not.toContain("Approved by the reviewer");
  });

  it("serializes question resolution behind an approval snapshot", async () => {
    const { app, store, base, caseId } = await seedAsync();
    const gate = createGate();
    const recordApprovalAsync = store.cases.recordApprovalAsync.bind(store.cases);
    const updateQuestionAsync = store.findings.updateOpenQuestionAsync.bind(store.findings);
    let writingApproval = false;
    let updatingQuestion = false;

    await store.tasks.createTaskAsync({
      id: "question-task",
      caseId,
      title: "Review question",
      assignedRole: "case-analysis",
      status: "completed",
      attempts: 1,
    });
    await store.findings.addFindingAsync(caseId, {
      ...finding("Needs a date check"),
      id: "question-finding",
      taskId: "question-task",
      attempt: 1,
      openQuestions: [{ id: "question-1", text: "Confirm the date", severity: "high" }],
    });

    store.cases.recordApprovalAsync = async (...args) => {
      writingApproval = true;
      await gate.opened;

      return recordApprovalAsync(...args);
    };

    store.findings.updateOpenQuestionAsync = async (...args) => {
      updatingQuestion = true;

      return updateQuestionAsync(...args);
    };

    const approval = request(app)
      .post(`${base}/approve`)
      .send({})
      .then((res) => res);

    await waitForAsync(() => writingApproval);

    const resolution = request(app)
      .post(`${base}/open-questions/question-1/resolve`)
      .send({})
      .then((res) => res);

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(updatingQuestion).toBe(false);
      expect(
        (await store.findings.getFindingsForCaseAsync(caseId))
          .flatMap((item) => item.openQuestions)
          .find((item) => item.id === "question-1")?.status,
      ).toBe("open");
    } finally {
      gate.release();
      await Promise.all([approval, resolution]);
    }

    expect((await approval).body.case.approval.unresolvedQuestionIds).toEqual(["question-1"]);
    expect((await resolution).status).toBe(200);
    expect(
      (await store.findings.getFindingsForCaseAsync(caseId))
        .flatMap((item) => item.openQuestions)
        .find((item) => item.id === "question-1")?.status,
    ).toBe("resolved");
  });

  it("clears approval before admitting a retry and serializes approvals with admission", async () => {
    const { app, store, caseId, base, orchestrator } = await seedAsync();
    const gate = createGate();
    const executionGate = createGate();
    const clearApprovalAsync = store.cases.clearApprovalAsync.bind(store.cases);
    const retryFailedAsync = orchestrator.retryFailedAsync.bind(orchestrator);
    let clearingApproval = false;

    orchestrator.retryFailedAsync = async (...args) => {
      await executionGate.opened;

      return retryFailedAsync(...args);
    };

    await store.cases.updateCaseStatusAsync(caseId, "failed");
    await store.tasks.createTaskAsync({
      id: "retry-task",
      caseId,
      title: "Retry analysis",
      assignedRole: "business-data-analyst",
      status: "failed",
      attempts: 1,
    });
    await store.cases.recordApprovalAsync(caseId, { note: "Approved before retry" });
    store.cases.clearApprovalAsync = async (...args) => {
      clearingApproval = true;
      await gate.opened;

      return clearApprovalAsync(...args);
    };

    const retry = request(app)
      .post(`${base}/retry`)
      .send({})
      .then((res) => res);

    await waitForAsync(() => clearingApproval);

    const approvalDuringAdmission = request(app)
      .post(`${base}/approve`)
      .send({})
      .then((res) => res);
    let approvalResponse: Awaited<typeof approvalDuringAdmission> | undefined;

    try {
      expect(await store.events.listEventsAsync(caseId)).toEqual([]);
      expect((await store.cases.getCaseAsync(caseId))?.approval?.note).toBe(
        "Approved before retry",
      );
    } finally {
      gate.release();
      await retry;
      approvalResponse = await approvalDuringAdmission;
      executionGate.release();
      await app.idleAsync();
    }

    expect((await retry).status).toBe(202);
    expect(approvalResponse.status).toBe(409);
    expect((await store.cases.getCaseAsync(caseId))?.approval).toBeUndefined();
  });

  it("clears approval before restarting a failed case through /run", async () => {
    const { app, store, caseId, base, orchestrator } = await seedAsync();
    const gate = createGate();
    const runCaseAsync = orchestrator.runCaseAsync.bind(orchestrator);
    let startingRun = false;

    await store.cases.updateCaseStatusAsync(caseId, "failed");
    await store.tasks.createTaskAsync({
      id: "failed-task",
      caseId,
      title: "Retry analysis",
      assignedRole: "business-data-analyst",
      status: "failed",
      attempts: 1,
    });
    await store.cases.recordApprovalAsync(caseId, { note: "Approved before restart" });

    orchestrator.runCaseAsync = async (...args) => {
      startingRun = true;
      await gate.opened;

      return runCaseAsync(...args);
    };

    try {
      await request(app).post(`${base}/run`).send({}).expect(202);
      await waitForAsync(() => startingRun);

      expect((await store.cases.getCaseAsync(caseId))?.approval).toBeUndefined();
      expect(await exportedTextAsync(app, base)).not.toContain("Approved by the reviewer");
    } finally {
      gate.release();
      await app.idleAsync();
    }
  });
});
