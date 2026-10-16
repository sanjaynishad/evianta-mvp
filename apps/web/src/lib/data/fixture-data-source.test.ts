import { describe, expect, it } from "vitest";
import {
  failedCaseId,
  failedCaseState,
  getSampleStateForUseCase,
  sampleCaseStates,
} from "@/fixtures";
import { getFixtureExtraction } from "@/fixtures/extractions";
import { createTestDataSource } from "@/test/render-with-data";

describe("fixture documents", () => {
  it("returns the extraction and the synthetic source file for a sample document", async () => {
    const dataSource = createTestDataSource();
    const detail = await dataSource.getDocumentAsync("sample-tax-notice", "b-doc-ledger");
    const table = detail.extraction?.tables[0];

    expect(detail.document.name).toBe("ledger_professional_receipts_FY2024-25.xlsx");
    expect(table?.range).toBe("A1:F201");
    expect(table?.rows.slice(180, 189).every((row) => row[2] === "Mehta Exports")).toBe(true);
    expect(table?.rows.slice(180, 189).reduce((sum, row) => sum + Number(row[4]), 0)).toBe(12400);
    expect(dataSource.getDocumentFileUrl("sample-tax-notice", "b-doc-notice")).toBe(
      "/fixtures/intimation_143_1a_AY2025-26.pdf",
    );
    expect(dataSource.getDocumentFileUrl("sample-tax-notice", "b-doc-ledger")).toBeUndefined();
  });

  it("keeps every quoted evidence on the page it cites", () => {
    for (const state of sampleCaseStates) {
      for (const evidence of state.findings.flatMap((finding) => finding.evidence)) {
        const quote = evidence.location?.textQuote;
        if (!quote || !evidence.documentId) {
          continue;
        }

        const page = getFixtureExtraction(evidence.documentId)?.pages.find(
          (candidate) => candidate.index === (evidence.location?.page ?? 1),
        );
        expect(page?.text.replace(/\s+/g, " "), evidence.id).toContain(quote);
      }
    }
  });
});

describe("fixture Ask", () => {
  it("answers suggested questions from the work record and streams the text", async () => {
    const dataSource = createTestDataSource();
    let streamed = "";
    const result = await dataSource.askAsync("sample-msme-payment", "Which invoices are unpaid?", {
      onDelta: (text) => (streamed += text),
    });

    expect(result.status).toBe("answered");
    expect(result.findingIds).toEqual(["c-finding-overdue"]);
    expect(result.status === "answered" ? result.evidence.map((item) => item.id) : []).toEqual([
      "c-ev-statement-rows",
      "c-ev-invoice-104",
    ]);
    expect(streamed).toContain("KF-2025-104");
  });

  it("says when the record does not support an answer", async () => {
    const result = await createTestDataSource().askAsync("sample-tax-notice", "Who won the match?");

    expect(result).toMatchObject({ status: "not-supported", canFlagForReview: true });
  });
});

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
