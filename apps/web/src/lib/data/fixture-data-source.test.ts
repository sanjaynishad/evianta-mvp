import { describe, expect, it } from "vitest";
import {
  failedCaseId,
  failedCaseState,
  getSampleStateForUseCase,
  sampleCaseStates,
} from "@/fixtures";
import {
  getFixtureExtraction,
  missingRegionRowCount,
  puneReturnRows,
} from "@/fixtures/extractions";
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

describe("sales fixture", () => {
  const table = getFixtureExtraction("a-doc-sales")!.tables[0]!;
  const rows = table.rows.map((cells, index) => ({
    row: index + 2,
    month: String(cells[1]).slice(0, 7),
    customer: String(cells[2]),
    region: cells[4] as string | null,
    gross: Number(cells[5]),
    returns: Number(cells[6]),
    net: Number(cells[7]),
  }));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const dataAnalysis = sampleCaseStates.find((state) => state.case.id === "sample-data-analysis")!;
  const chartData = (chartId: string) =>
    JSON.parse(
      dataAnalysis.deliverables
        .flatMap((deliverable) => deliverable.sections)
        .find((section) => section.id === `a-section-${chartId}`)!.content,
    ).data as Record<string, number | string>[];

  it("reconciles monthly net sales and returns with the dashboard", () => {
    const months = ["2025-07", "2025-08", "2025-09"];
    const chart = chartData("chart-net-sales-by-month");

    expect(rows).toHaveLength(1840);
    expect(rows.every((row) => row.gross === row.net + row.returns)).toBe(true);
    months.forEach((month, index) => {
      const inMonth = rows.filter((row) => row.month === month);
      expect(sum(inMonth.map((row) => row.net))).toBe(chart[index]!.netSales);
      expect(sum(inMonth.map((row) => row.returns))).toBe(chart[index]!.returns);
    });
  });

  it("reconciles the regional split, missing regions, and West returns", () => {
    const share = Object.fromEntries(
      chartData("chart-region-share").map((item) => [item.region, item.netSales]),
    );
    for (const region of ["West", "North", "South"]) {
      expect(sum(rows.filter((row) => row.region === region).map((row) => row.net))).toBe(
        share[region],
      );
    }

    const missing = rows.filter((row) => row.region === null);
    expect(missing).toHaveLength(missingRegionRowCount);
    expect(sum(missing.map((row) => row.net))).toBe(945000);

    const westAugust = rows.filter((row) => row.region === "West" && row.month === "2025-08");
    const westAugustReturns = sum(westAugust.map((row) => row.returns));
    expect(westAugustReturns / sum(westAugust.map((row) => row.gross))).toBeCloseTo(0.092, 3);
    const pune = rows.filter(
      (row) => row.row >= puneReturnRows.start && row.row <= puneReturnRows.end,
    );
    expect(pune.every((row) => row.customer === "Deccan Distributors, Pune")).toBe(true);
    expect(pune.every((row) => row.month === "2025-08" && row.region === "West")).toBe(true);
    expect(sum(pune.map((row) => row.returns)) / westAugustReturns).toBeCloseTo(0.71, 2);
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
  it.each(["Reviewer text", null])(
    "clears case approval when section content changes to %s",
    async (editedContent) => {
      const dataSource = createTestDataSource();
      const copy = await dataSource.copyCaseAsync("sample-tax-notice");
      await dataSource.approveCaseAsync(copy.id);

      await dataSource.updateSectionAsync(copy.id, "b-deliverable-pack", "b-section-draft", {
        reviewStatus: "approved",
      });
      expect((await dataSource.getCaseStateAsync(copy.id)).case.approval).toBeDefined();

      await dataSource.updateSectionAsync(copy.id, "b-deliverable-pack", "b-section-draft", {
        editedContent,
      });
      expect((await dataSource.getCaseStateAsync(copy.id)).case.approval).toBeUndefined();
    },
  );

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
