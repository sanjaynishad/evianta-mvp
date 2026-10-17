import JSZip from "jszip";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestHarness, waitForAsync } from "./testing/harness.js";

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
});
