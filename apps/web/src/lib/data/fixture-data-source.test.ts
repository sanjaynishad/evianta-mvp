import { describe, expect, it } from "vitest";
import { failedCaseId, failedCaseState, getSampleStateForUseCase } from "@/fixtures";
import { createTestDataSource } from "@/test/render-with-data";

describe("fixture data source", () => {
  it("copies a sample without its usage or approval, like the store", async () => {
    const approvedSample = structuredClone(getSampleStateForUseCase("data-analysis"));
    approvedSample.case.approval = {
      approvedAt: "2026-10-17T00:00:00.000Z",
      unresolvedQuestionIds: [],
      note: "Approved source",
    };
    const dataSource = createTestDataSource({ seedStates: [approvedSample] });
    const sample = (await dataSource.getCaseStateAsync("sample-data-analysis")).case;
    expect(sample.usage?.runCount).toBeGreaterThan(0);
    expect(sample.approval).toBeDefined();

    const copy = await dataSource.copyCaseAsync("sample-data-analysis");
    const copied = await dataSource.getCaseStateAsync(copy.id);

    expect(copied.case.usage).toBeUndefined();
    expect(copied.case.approval).toBeUndefined();
    expect(copied.case.sourceCaseId).toBe("sample-data-analysis");
  });

  it("rejects uploads once a case is planned and runs while uploads are stored", async () => {
    const dataSource = createTestDataSource({ replayIntervalMs: 20 });
    const created = await dataSource.createCaseAsync({ title: "Sales", useCase: "data-analysis" });

    const uploading = dataSource.uploadDocumentAsync(created.id, new File(["a"], "sales.csv"));
    await expect(dataSource.startRunAsync(created.id)).rejects.toMatchObject({
      code: "upload-in-progress",
    });
    await uploading;

    await dataSource.startRunAsync(created.id);
    await expect(
      dataSource.uploadDocumentAsync(created.id, new File(["b"], "more.csv")),
    ).rejects.toMatchObject({ code: "run-in-progress" });
  });

  it("rejects uploads once the case has been planned", async () => {
    const dataSource = createTestDataSource({ seedStates: [failedCaseState] });

    await expect(
      dataSource.uploadDocumentAsync(failedCaseId, new File(["b"], "more.csv")),
    ).rejects.toMatchObject({ status: 409, code: "case-already-planned" });
  });
});
