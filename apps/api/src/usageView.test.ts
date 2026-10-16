import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestHarness, seedSampleAsync, VISITOR_A, VISITOR_B } from "./testing/harness.js";

const USAGE_PATH = "ops-7f3k9q2x";

async function seedCasesAsync(harness: ReturnType<typeof createTestHarness>) {
  const { store } = harness;

  await seedSampleAsync(store);

  const taxCase = await store.cases.createCaseAsync({
    title: "Tax notice",
    useCase: "tax-notice",
    visitorId: VISITOR_A,
  });

  await store.cases.updateCaseUsageAsync(taxCase.id, {
    inputTokens: 1000,
    outputTokens: 200,
    costEstimate: 0.002,
    runCount: 2,
    lastRunAt: "2026-10-01T10:00:00.000Z",
  });
  await store.documents.addDocumentMetadataAsync({
    id: "doc-1",
    caseId: taxCase.id,
    name: "notice.pdf",
    mimeType: "application/pdf",
    size: 10,
    gcsPath: "memory://bucket/notice.pdf",
    uploadedAt: "2026-10-01T09:00:00.000Z",
  });

  const msmeCase = await store.cases.createCaseAsync({
    title: "MSME dispute",
    useCase: "msme-payment",
    visitorId: VISITOR_B,
  });

  await store.cases.updateCaseUsageAsync(msmeCase.id, {
    inputTokens: 500,
    outputTokens: 50,
    costEstimate: 0.001,
    runCount: 1,
  });

  return { taxCase, msmeCase };
}

describe("usage view", () => {
  it("is not registered when the path is unset", async () => {
    const harness = createTestHarness();

    await seedCasesAsync(harness);

    const response = await request(harness.app).get(`/${USAGE_PATH}/cases`).expect(404);

    expect(response.body).toEqual({ error: "not-found", message: "Not found." });
  });

  it("lists every visitor's cases with metadata only and noindex", async () => {
    const harness = createTestHarness({ config: { usageViewPath: USAGE_PATH } });
    const { taxCase } = await seedCasesAsync(harness);

    const response = await request(harness.app).get(`/${USAGE_PATH}/cases`).expect(200);

    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.cases).toHaveLength(3);
    expect(
      new Set(response.body.cases.map((row: { visitorId?: string }) => row.visitorId)),
    ).toEqual(new Set([undefined, VISITOR_A, VISITOR_B]));
    expect(response.body.cases.find((row: { id: string }) => row.id === taxCase.id)).toEqual({
      id: taxCase.id,
      title: "Tax notice",
      useCase: "tax-notice",
      status: "draft",
      visitorId: VISITOR_A,
      isSample: false,
      isCopy: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      lastRunAt: "2026-10-01T10:00:00.000Z",
      approved: false,
      documentCount: 1,
      runCount: 2,
      tokenUsage: { input: 1000, output: 200, total: 1200 },
      costEstimate: 0.002,
    });
    expect(JSON.stringify(response.body)).not.toContain("memory://");

    const firstPage = await request(harness.app)
      .get(`/${USAGE_PATH}/cases`)
      .query({ limit: 2 })
      .expect(200);

    expect(firstPage.body.cases).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(harness.app)
      .get(`/${USAGE_PATH}/cases`)
      .query({ limit: 2, cursor: firstPage.body.nextCursor })
      .expect(200);

    expect(secondPage.body.cases).toHaveLength(1);
    await request(harness.app).get(`/${USAGE_PATH}/cases`).query({ limit: 0 }).expect(400);
  });

  it("summarizes totals overall and per use case", async () => {
    const harness = createTestHarness({ config: { usageViewPath: `/${USAGE_PATH}/` } });

    await seedCasesAsync(harness);

    const response = await request(harness.app).get(`/${USAGE_PATH}/summary`).expect(200);

    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.body.totals).toEqual({
      cases: 3,
      samples: 1,
      copies: 0,
      runs: 3,
      visitors: 2,
      tokenUsage: { input: 1500, output: 250, total: 1750 },
      costEstimate: 0.003,
    });
    expect(response.body.byUseCase["tax-notice"]).toMatchObject({ cases: 1, runs: 2, visitors: 1 });
    expect(response.body.byUseCase["data-analysis"]).toMatchObject({ cases: 1, samples: 1 });
    expect(response.body.byUseCase["msme-payment"]).toMatchObject({ costEstimate: 0.001 });
  });

  it("returns a plain 404 for wrong or partial paths", async () => {
    const harness = createTestHarness({ config: { usageViewPath: USAGE_PATH } });

    for (const path of [
      "/ops-wrong/cases",
      `/${USAGE_PATH}x/cases`,
      `/${USAGE_PATH.slice(0, 4)}/summary`,
      `/${USAGE_PATH}/documents`,
    ]) {
      const response = await request(harness.app).get(path).expect(404);

      expect(response.body).toEqual({ error: "not-found", message: "Not found." });
    }
  });
});
