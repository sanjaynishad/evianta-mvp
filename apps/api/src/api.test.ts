import { seedAgentDirectoryAsync } from "@evianta/agents";
import type { Store } from "@evianta/store";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  asText,
  createTestHarness,
  seedSampleAsync,
  sseFramesOf,
  VISITOR_A,
  VISITOR_B,
} from "./testing/harness.js";

async function seedReviewedCaseAsync(store: Store) {
  const caseRecord = await store.cases.createCaseAsync({
    title: "Notice under section 143(1)",
    useCase: "tax-notice",
    visitorId: VISITOR_A,
    status: "completed",
  });

  await store.tasks.createTaskAsync({
    id: "t1",
    caseId: caseRecord.id,
    title: "Analyze the notice",
    assignedRole: "case-analysis",
    status: "completed",
    attempts: 1,
  });
  await store.evidence.addEvidenceAsync(caseRecord.id, {
    id: "e1",
    sourceRef: "26AS p.2",
    description: "TDS credit for Q4",
    excerpt: "TDS deducted 12,400",
  });
  await store.findings.addFindingAsync(caseRecord.id, {
    id: "f1",
    taskId: "t1",
    attempt: 1,
    summary: "TDS mismatch of Rs. 12,400",
    severity: "high",
    confidence: "high",
    evidence: [
      {
        id: "e1",
        sourceRef: "26AS p.2",
        description: "TDS credit for Q4",
        excerpt: "TDS deducted 12,400",
      },
    ],
    openQuestions: [
      { id: "q-low", text: "Confirm the bank account", severity: "low" },
      { id: "q-high", text: "Was Form 16A issued?", severity: "high" },
      { id: "q-medium", text: "Check the challan date", severity: "medium" },
    ],
  });
  await store.deliverables.saveDeliverableAsync({
    id: "deliverable-primary",
    caseId: caseRecord.id,
    title: "Notice response pack",
    format: "document",
    sections: [
      {
        id: "t1-section-1",
        title: "Response draft",
        kind: "text",
        content: "We submit that the TDS credit was claimed correctly.",
        producedByRole: "response-preparation",
        findingIds: ["f1"],
        evidenceIds: ["e1"],
      },
    ],
  });

  return caseRecord;
}

describe("request validation", () => {
  it("returns 400 with issues for malformed bodies, params, and headers", async () => {
    const { app, store } = createTestHarness();
    const caseRecord = await seedReviewedCaseAsync(store);
    const caseUrl = `/cases/${caseRecord.id}`;

    const missingTitle = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ useCase: "tax-notice" })
      .expect(400);

    expect(missingTitle.body).toMatchObject({ error: "invalid-request" });
    expect(missingTitle.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["title"] })]),
    );

    await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "x", useCase: "astrology" })
      .expect(400);
    await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "x", useCase: "tax-notice", owner: "someone" })
      .expect(400);

    const badJson = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .set("Content-Type", "application/json")
      .send('{"title": ')
      .expect(400);

    expect(badJson.body).toEqual({
      error: "invalid-json",
      message: "The request body is not valid JSON.",
    });

    const noVisitor = await request(app)
      .post("/cases")
      .send({ title: "x", useCase: "tax-notice" })
      .expect(400);

    expect(noVisitor.body.error).toBe("visitor-required");
    await request(app).get("/cases").set("X-Evianta-Visitor", "bad id!").expect(400);

    await request(app)
      .patch(`${caseUrl}/deliverables/deliverable-primary/sections/t1-section-1`)
      .send({})
      .expect(400);
    await request(app)
      .patch(`${caseUrl}/deliverables/deliverable-primary/sections/t1-section-1`)
      .send({ reviewStatus: "rubber-stamped" })
      .expect(400);
    await request(app)
      .post(`${caseUrl}/open-questions/q-low/resolve`)
      .send({ note: 42 })
      .expect(400);
    await request(app).post(`${caseUrl}/ask`).send({ question: "   " }).expect(400);
    await request(app)
      .get(`${caseUrl}/deliverables/deliverable-primary/export`)
      .query({ format: "pdf" })
      .expect(400);
    await request(app).get(`${caseUrl}/stream`).query({ after: "-1" }).expect(400);
    await request(app).get(`${caseUrl}/stream`).set("Last-Event-ID", "abc").expect(400);
    await request(app).get("/agents").query({ enabled: "yes" }).expect(400);
  });

  it("validates uploads against the supported types", async () => {
    const { app, store } = createTestHarness();
    const caseRecord = await store.cases.createCaseAsync({
      title: "Uploads",
      useCase: "data-analysis",
      visitorId: VISITOR_A,
    });
    const url = `/cases/${caseRecord.id}/documents`;

    const noFiles = await request(app).post(url).send({ name: "x" }).expect(400);

    expect(noFiles.body.error).toBe("no-files");

    const gif = await request(app)
      .post(url)
      .attach("files", Buffer.from("GIF89a....."), {
        filename: "chart.gif",
        contentType: "image/gif",
      })
      .expect(415);

    expect(gif.body.error).toBe("unsupported-media-type");

    await request(app)
      .post(url)
      .attach("files", Buffer.from("<html><script>alert(1)</script></html>"), {
        filename: "page.html",
        contentType: "text/html",
      })
      .expect(415);
    await request(app)
      .post(url)
      .attach("files", Buffer.alloc(0), { filename: "empty.csv", contentType: "text/csv" })
      .expect(400);
    await request(app)
      .post(url)
      .attach("attachment", Buffer.from("a,b\n1,2"), { filename: "x.csv", contentType: "text/csv" })
      .expect(400);

    expect(await store.documents.getDocumentsForCaseAsync(caseRecord.id)).toEqual([]);

    const accepted = await request(app)
      .post(url)
      .attach("file", Buffer.from("a,b\n1,2"), {
        filename: "ledger.csv",
        contentType: "application/vnd.ms-excel",
      })
      .expect(201);

    expect(accepted.body.documents[0]).toMatchObject({ name: "ledger.csv", mimeType: "text/csv" });
  });

  it("returns 404 without details for unknown cases and routes", async () => {
    const { app } = createTestHarness();

    const missing = await request(app).get("/cases/does-not-exist").expect(404);

    expect(missing.body).toEqual({ error: "not-found", message: "The case was not found." });
    await request(app).post("/cases/does-not-exist/run").expect(404);
    await request(app).get("/cases/does-not-exist/stream").expect(404);
    await request(app).get("/cases/does-not-exist/deliverables/x").expect(404);

    const unknown = await request(app).get("/nothing-here").expect(404);

    expect(unknown.body).toEqual({ error: "not-found", message: "Not found." });
  });
});

describe("visitor scoping and samples", () => {
  it("lists only the calling visitor's cases and keeps samples separate", async () => {
    const { app, store } = createTestHarness();
    const sample = await seedSampleAsync(store);
    const created = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "A's case", useCase: "data-analysis" })
      .expect(201);

    expect(created.headers.location).toBe(`/cases/${created.body.id}`);
    expect(created.body).toMatchObject({ visitorId: VISITOR_A, isSample: false, status: "draft" });

    await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_B)
      .send({ title: "B's case", useCase: "msme-payment" })
      .expect(201);

    const listA = await request(app).get("/cases").set("X-Evianta-Visitor", VISITOR_A).expect(200);
    const listB = await request(app).get("/cases").set("X-Evianta-Visitor", VISITOR_B).expect(200);
    const samples = await request(app).get("/samples").expect(200);

    expect(listA.body.cases.map((item: { title: string }) => item.title)).toEqual(["A's case"]);
    expect(listB.body.cases.map((item: { title: string }) => item.title)).toEqual(["B's case"]);
    expect(samples.body.cases.map((item: { id: string }) => item.id)).toEqual([sample.id]);

    await request(app)
      .get(`/cases/${created.body.id}`)
      .set("X-Evianta-Visitor", VISITOR_B)
      .expect(200);
  });

  it("rejects mutations on samples with a copy link and copies them for the visitor", async () => {
    const { app, store } = createTestHarness();
    const sample = await seedSampleAsync(store);
    const base = `/cases/${sample.id}`;
    const readOnly = {
      error: "sample-read-only",
      reason: "sample-read-only",
      copyUrl: `${base}/copy`,
    };
    const attempts = [
      request(app)
        .post(`${base}/documents`)
        .attach("files", Buffer.from("a,b\n1,2"), { filename: "x.csv", contentType: "text/csv" }),
      request(app).post(`${base}/run`),
      request(app).post(`${base}/retry`),
      request(app)
        .patch(`${base}/deliverables/deliverable-primary/sections/t1-section-1`)
        .send({ editedContent: "Changed" }),
      request(app).post(`${base}/open-questions/q1/resolve`).send({}),
      request(app).post(`${base}/open-questions/q1/dismiss`).send({}),
      request(app).post(`${base}/approve`).send({}),
    ];

    for (const attempt of attempts) {
      const response = await attempt;

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject(readOnly);
    }

    const copy = await request(app)
      .post(`${base}/copy`)
      .set("X-Evianta-Visitor", VISITOR_A)
      .expect(201);

    expect(copy.body).toMatchObject({
      isSample: false,
      visitorId: VISITOR_A,
      sourceCaseId: sample.id,
    });
    expect(copy.body.id).not.toBe(sample.id);

    await request(app)
      .patch(`/cases/${copy.body.id}/deliverables/deliverable-primary/sections/t1-section-1`)
      .send({ editedContent: "Visitor edit" })
      .expect(200);

    const sampleDeliverable = await request(app)
      .get(`${base}/deliverables/deliverable-primary`)
      .expect(200);
    const listA = await request(app).get("/cases").set("X-Evianta-Visitor", VISITOR_A).expect(200);

    expect(sampleDeliverable.body.sections[0].editedContent).toBeUndefined();
    expect(listA.body.cases.map((item: { id: string }) => item.id)).toEqual([copy.body.id]);

    const ownCase = await request(app)
      .post(`/cases/${copy.body.id}/copy`)
      .set("X-Evianta-Visitor", VISITOR_A)
      .expect(422);

    expect(ownCase.body.error).toBe("not-a-sample");
  });
});

describe("review actions", () => {
  it("edits sections, manages open questions, and records approval", async () => {
    const { app, store } = createTestHarness();
    const caseRecord = await seedReviewedCaseAsync(store);
    const base = `/cases/${caseRecord.id}`;

    const edited = await request(app)
      .patch(`${base}/deliverables/deliverable-primary/sections/t1-section-1`)
      .send({ editedContent: "Revised by the reviewer.", reviewStatus: "approved" })
      .expect(200);

    expect(edited.body.sections[0]).toMatchObject({
      editedContent: "Revised by the reviewer.",
      reviewStatus: "approved",
      content: "We submit that the TDS credit was claimed correctly.",
    });

    const cleared = await request(app)
      .patch(`${base}/deliverables/deliverable-primary/sections/t1-section-1`)
      .send({ editedContent: null, reviewComment: "Keep the original wording." })
      .expect(200);

    expect(cleared.body.sections[0].editedContent).toBeUndefined();
    expect(cleared.body.sections[0].reviewComment).toBe("Keep the original wording.");
    await request(app)
      .patch(`${base}/deliverables/deliverable-primary/sections/missing`)
      .send({ reviewStatus: "approved" })
      .expect(404);
    await request(app)
      .patch(`${base}/deliverables/missing/sections/t1-section-1`)
      .send({ reviewStatus: "approved" })
      .expect(404);

    const resolved = await request(app)
      .post(`${base}/open-questions/q-high/resolve`)
      .send({ note: "Form 16A was issued on 12 May." })
      .expect(200);

    expect(
      resolved.body.finding.openQuestions.find((item: { id: string }) => item.id === "q-high"),
    ).toMatchObject({ status: "resolved", resolutionNote: "Form 16A was issued on 12 May." });

    await request(app).post(`${base}/open-questions/q-low/dismiss`).expect(200);
    await request(app).post(`${base}/open-questions/q-unknown/resolve`).send({}).expect(404);

    const approval = await request(app)
      .post(`${base}/approve`)
      .send({ note: "Ready to file after the challan check." })
      .expect(200);

    expect(approval.body.unresolvedQuestions.map((item: { id: string }) => item.id)).toEqual([
      "q-medium",
    ]);
    expect(approval.body.case.approval).toMatchObject({
      unresolvedQuestionIds: ["q-medium"],
      note: "Ready to file after the challan check.",
      approvedAt: expect.any(String),
    });
  });

  it("streams a grounded answer as answer-delta events followed by the answer", async () => {
    const { app, store, ai } = createTestHarness({
      script: {
        "case-assistant": {
          output: {
            supported: true,
            answer: "The TDS mismatch is Rs. 12,400 because the 26AS credit for Q4 is missing.",
            evidenceIds: ["e1"],
            findingIds: ["f1"],
          },
          usage: { input: 700, output: 60 },
        },
      },
    });
    const caseRecord = await seedReviewedCaseAsync(store);
    const response = await asText(
      request(app)
        .post(`/cases/${caseRecord.id}/ask`)
        .send({ question: "Why is there a TDS mismatch?" }),
    ).expect(200);
    const frames = sseFramesOf(response);
    const deltas = frames.filter((frame) => frame.event === "answer-delta");
    const answer = frames.at(-1);

    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((frame) => (frame.data as { text: string }).text).join("")).toBe(
      "The TDS mismatch is Rs. 12,400 because the 26AS credit for Q4 is missing.",
    );
    expect(answer).toMatchObject({
      event: "answer",
      data: { status: "answered", evidenceIds: ["e1"], findingIds: ["f1"] },
    });
    expect(ai.calls.map((call) => call.key)).toEqual(["case-assistant"]);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.usage?.inputTokens).toBeGreaterThan(0);

    const unsupported = sseFramesOf(
      await asText(
        request(app).post(`/cases/${caseRecord.id}/ask`).send({ question: "zzz qqq" }),
      ).expect(200),
    );

    expect(unsupported.at(-1)).toMatchObject({
      event: "answer",
      data: { status: "not-supported", canFlagForReview: true },
    });

    ai.script("case-assistant", { error: new Error("socket hang up") });

    const failed = sseFramesOf(
      await asText(
        request(app)
          .post(`/cases/${caseRecord.id}/ask`)
          .send({ question: "Why the TDS mismatch?" }),
      ).expect(200),
    );

    expect(failed).toEqual([
      {
        event: "error",
        data: {
          error: "ask-failed",
          message: "The assistant could not answer right now. Try again.",
        },
      },
    ]);
  });
});

describe("agent directory", () => {
  it("lists persisted profiles with a role list and filters to enabled ones", async () => {
    const { app, store } = createTestHarness();
    const profiles = await seedAgentDirectoryAsync(store);
    const reviewer = profiles.find((profile) => profile.role === "independent-review");

    await store.agents.upsertProfileAsync({ ...reviewer!, enabled: false });

    const all = await request(app).get("/agents").expect(200);
    const enabled = await request(app).get("/agents").query({ enabled: "true" }).expect(200);

    expect(all.body.roles).toContain("independent-review");
    expect(all.body.agents).toHaveLength(profiles.length);
    expect(enabled.body.roles).not.toContain("independent-review");
    expect(enabled.body.roles).toEqual(
      enabled.body.agents.map((agent: { role: string }) => agent.role),
    );

    const coordinator = await request(app).get("/agents/coordinator").expect(200);

    expect(coordinator.body).toMatchObject({ role: "coordinator", modelTier: expect.any(String) });
    await request(app).get("/agents/astrologer").expect(404);
  });
});

describe("CORS", () => {
  it("allows only the configured web origin", async () => {
    const { app } = createTestHarness({ config: { webOrigins: ["https://web.example"] } });

    const allowed = await request(app)
      .get("/healthz")
      .set("Origin", "https://web.example")
      .expect(200);
    const denied = await request(app).get("/healthz").set("Origin", "https://evil.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe("https://web.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await request(app)
      .options("/cases")
      .set("Origin", "https://web.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-evianta-visitor")
      .expect(204);

    expect(preflight.headers["access-control-allow-headers"]).toContain("X-Evianta-Visitor");
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    await request(app)
      .options("/cases")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST")
      .expect(403);
  });
});
