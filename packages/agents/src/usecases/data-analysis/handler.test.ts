import type { Deliverable, ExtractedTable, Finding } from "@evianta/core";
import { parseChartSpecContent } from "@evianta/core";
import { ingestDocumentAsync } from "@evianta/ingest";
import { createInMemoryDocumentStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { createAgentRegistry, createDefaultTaskHandlers } from "../../registry.js";
import { addDocumentAsync, createCaseAsync, createHarness } from "../../testing/fixtures.js";
import {
  CSV_MIME,
  extractFixtureAsync,
  fixtureMetadata,
  SALES_EXPECTED,
  salesCsv,
  salesWorkbook,
  XLSX_MIME,
} from "../../testing/salesFixture.js";
import { isMaterialFinding, runDeterministicChecks } from "../../verification.js";
import {
  dataAnalystOutputSchema,
  isDataAnalystAgent,
  type DataAnalystOutputInput,
} from "./agent.js";
import { analyzeTable } from "./analysis.js";
import { buildDataAnalystTaskOutput, DATA_ANALYST_REPORT_SECTIONS } from "./handler.js";

const analystOutput: DataAnalystOutputInput = {
  summary:
    "Sales totalled {{total-amount}} over {{period-count}} months, and June was {{growth-first-to-last-pct}} above January.",
  trends:
    "Monthly sales rose by about {{trend-slope-per-month}} a month. South led with {{segment-region-south-share-pct}} of sales.",
  anomalies:
    "April reached {{period-2024-04-total}}, {{anomaly-2024-04-deviation-pct}} above the trend; two large orders drive it.",
  insights: [
    {
      summary: "April sales of {{period-2024-04-total}} sit far above the trend",
      severity: "high",
      metricIds: ["period-2024-04-total"],
      anomalyIds: ["anomaly-2024-04"],
      openQuestions: [
        { text: "Were the two large April orders one-off deals?", severity: "medium" },
      ],
    },
    {
      summary: "Repeated and non-numeric June rows make June less certain",
      severity: "medium",
      issueIds: ["dq-duplicate-rows", "dq-type-mismatch-amount-inr"],
    },
    { summary: "Most customers buy again", severity: "medium" },
    {
      summary: "Volume reached {{total-quantity}} units",
      severity: "low",
      metricIds: ["total-quantity"],
    },
  ],
  assumptions: ["Negative amounts are returns."],
  openQuestions: [{ text: "Is June complete?", severity: "low" }],
};

const coordinatorStep = {
  output: {
    tasks: [
      { assignedRole: "business-data-analyst", title: "Analyze the sales data", dependsOn: [] },
    ],
  },
};

const formats = [
  { name: "sales.csv", mimeType: CSV_MIME, sheet: undefined, bytes: () => Buffer.from(salesCsv()) },
  {
    name: "sales.xlsx",
    mimeType: XLSX_MIME,
    sheet: "Sales",
    bytes: () => Buffer.from(salesWorkbook()),
  },
] as const;

async function runSalesCaseAsync(
  format: (typeof formats)[number],
  output: DataAnalystOutputInput = analystOutput,
) {
  const harness = createHarness({
    coordinator: coordinatorStep,
    "business-data-analyst": { output, usage: { input: 3000, output: 600 } },
  });
  const { store, ai } = harness;
  const caseRecord = await createCaseAsync(store, "data-analysis");
  const documentStore = createInMemoryDocumentStore();
  const bytes = format.bytes();
  const gcsPath = await documentStore.uploadAsync(
    caseRecord.id,
    format.name,
    format.mimeType,
    bytes,
  );
  const document = await store.documents.addDocumentMetadataAsync({
    id: "doc-sales",
    caseId: caseRecord.id,
    name: format.name,
    mimeType: format.mimeType,
    size: bytes.byteLength,
    gcsPath,
    uploadedAt: "2024-07-01T00:00:00.000Z",
  });
  const ingested = await ingestDocumentAsync({
    caseId: caseRecord.id,
    document,
    store,
    documentStore,
    ai,
  });
  const result = await harness.orchestrator.runCaseAsync(caseRecord.id);
  const [findings, deliverables, tasks, extraction] = await Promise.all([
    store.findings.getFindingsForCaseAsync(caseRecord.id),
    store.deliverables.getDeliverablesForCaseAsync(caseRecord.id),
    store.tasks.getTasksForCaseAsync(caseRecord.id),
    store.documents.getExtractionAsync(caseRecord.id, document.id),
  ]);
  const table = extraction?.tables[0];

  if (!table) {
    throw new Error("The fixture was not extracted.");
  }

  const analysis = analyzeTable({ documentId: document.id, documentName: format.name, table });

  return { ...harness, ingested, result, findings, deliverables, tasks, analysis };
}

function byFormat(deliverables: readonly Deliverable[], format: Deliverable["format"]) {
  return deliverables.find((deliverable) => deliverable.format === format);
}

function section(deliverable: Deliverable | undefined, title: string) {
  return deliverable?.sections.find((candidate) => candidate.title === title);
}

describe("business data analyst through the orchestrator", () => {
  it.each(formats)("produces a report and a dashboard from $name", async (format) => {
    const { ai, ingested, result, findings, deliverables, tasks, analysis } =
      await runSalesCaseAsync(format);

    expect(ingested.cached).toBe(false);
    expect(result.status).toBe("completed");
    expect(ai.calls.map((call) => call.key)).toEqual(["coordinator", "business-data-analyst"]);
    expect(ai.calls[1]?.tier).toBe("mid");
    expect(tasks[0]).toMatchObject({ status: "completed", tokenUsage: { total: 3600 } });

    const prompt = ai.calls[1]?.prompt ?? "";

    expect(prompt).toContain("total-amount");
    expect(prompt).toContain("SO-1001");
    expect(prompt).not.toContain("SO-1020");
    expect(prompt).not.toContain("SO-1027");

    const report = byFormat(deliverables, "report");
    const dashboard = byFormat(deliverables, "dashboard");

    expect(report).toMatchObject({ id: "deliverable-primary", title: "Analysis report" });
    expect(report?.sections.map((item) => item.title)).toEqual([...DATA_ANALYST_REPORT_SECTIONS]);
    expect(section(report, "Summary")?.content).toBe(
      "Sales totalled ₹92,000 over 6 months, and June was 50% above January.",
    );
    expect(section(report, "Trends")?.content).toContain("South led with 40.43% of sales.");
    expect(section(report, "Trends")?.content).toContain(
      "| 2024-04 (flagged) | ₹30,000 | 150% | 4 |",
    );
    expect(section(report, "Anomalies")?.content).toContain("April reached ₹30,000, 130.77% above");
    expect(section(report, "Key metrics")?.content).toContain("| Total Amount (INR) | ₹92,000 |");
    expect(section(report, "Data quality")?.content).toContain(
      format.sheet ? "Sales!G28" : "| G28 |",
    );
    expect(section(report, "Assumptions and open questions")?.content).toContain(
      "Negative amounts are returns.",
    );

    expect(dashboard).toMatchObject({ id: "deliverable-dashboard", title: "Dashboard" });

    const specs = (dashboard?.sections ?? []).map((item) => {
      const parsed = parseChartSpecContent(item.content);

      if (!parsed.success) {
        throw new Error(parsed.error);
      }

      return { section: item, spec: parsed.spec };
    });

    expect(specs.map(({ spec }) => spec.type)).toEqual(["line", "bar", "bar", "pie", "bar", "bar"]);
    expect(specs.every(({ section: item }) => item.kind === "chart")).toBe(true);
    expect(specs.every(({ section: item }) => item.evidenceIds.length > 0)).toBe(true);
    expect(specs[0]?.spec.data).toEqual(
      SALES_EXPECTED.monthlyTotals.map(([month, total]) => ({ month, total })),
    );
    expect(specs[0]?.spec.yAxis?.format).toBe("currency-inr");
    expect(specs[0]?.spec.source).toMatchObject({ documentId: "doc-sales" });
    expect(specs[0]?.spec.source?.aggregation).toContain(
      format.sheet ? "Sales!G2:G29" : "(G2:G29)",
    );
    expect(specs[3]?.spec.data).toEqual([
      { segment: "South", total: 37200 },
      { segment: "North", total: 27500 },
      { segment: "West", total: 12600 },
      { segment: "East", total: 12200 },
      { segment: "Unassigned", total: 2500 },
    ]);

    const material = findings.filter((finding) => isMaterialFinding(finding));

    expect(material.length).toBeGreaterThan(5);

    for (const finding of material) {
      expect(finding.evidence.length, finding.summary).toBeGreaterThan(0);

      for (const item of finding.evidence) {
        expect(item.documentId).toBe("doc-sales");
        expect(item.location?.cellRange).toBeTruthy();
        expect(item.location?.sheet).toBe(format.sheet);
        expect(item.confidence).toBe("high");
      }
    }

    for (const figure of findings.flatMap((finding) => finding.figures ?? [])) {
      expect(figure.value, figure.key).toBe(analysis.metricsById.get(figure.key)?.value);
    }

    expect(runDeterministicChecks(findings).passed).toBe(true);

    const mismatch = findings.find((finding) =>
      finding.summary.startsWith("1 Amount (INR) value is not a number"),
    );

    expect(mismatch?.evidence[0]?.location).toMatchObject({
      cellRange: "G28",
      rowRange: { start: 28, end: 28 },
    });

    const anomaly = findings.find((finding) =>
      finding.summary.startsWith("Amount (INR) in 2024-04"),
    );

    expect(anomaly).toMatchObject({ severity: "medium" });
    expect(anomaly?.evidence[0]?.location?.cellRange).toBe("A14:G17");

    const overview = findings.find((finding) => finding.summary.startsWith("₹92,000 total"));
    const volume = findings.find((finding) => finding.summary === "Volume reached 265 units");

    expect(overview?.evidence.map((item) => item.location?.cellRange)).toEqual([
      "G2:G29",
      "F2:F29",
      "B2:B29",
    ]);
    expect(volume?.evidence.map((item) => item.location?.cellRange)).toEqual(["F2:F29"]);
    expect(section(report, "Anomalies")?.content).toContain(
      "1 of 6 months had a robust z-score above 3.5 against the trend.",
    );

    const unsupported = findings.find((finding) => finding.summary === "Most customers buy again");

    expect(unsupported?.evidence.length).toBeGreaterThan(0);
    expect(unsupported?.openQuestions[0]?.text).toContain("does not cite a computed metric");
    expect(findings.some((finding) => finding.summary.includes("could not be matched"))).toBe(
      false,
    );
  });

  it("flags narrative numbers that do not match the computed metrics", async () => {
    const { result, findings, deliverables } = await runSalesCaseAsync(formats[0], {
      ...analystOutput,
      summary: "Sales totalled 95,000, led by {{segment-region-north-total}} from {{top-region}}.",
    });
    const check = findings.find((finding: Finding) =>
      finding.summary.includes("could not be matched to computed metrics"),
    );

    expect(result.status).toBe("completed");
    expect(check?.openQuestions.map((question) => question.text)).toEqual([
      'The summary states "95,000", which does not match any computed metric. Check this statement before relying on it.',
      'The summary references "top-region", which is not a computed metric. Check this statement before relying on it.',
    ]);
    expect(section(byFormat(deliverables, "report"), "Summary")?.content).toBe(
      "Sales totalled 95,000, led by ₹27,500 from [figure not computed].",
    );
  });

  it("fails the task with a clear reason when the case has no spreadsheet", async () => {
    const { store, ai, orchestrator } = createHarness({ coordinator: coordinatorStep });
    const caseRecord = await createCaseAsync(store, "data-analysis");

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-memo",
      name: "memo.pdf",
      pages: ["Quarterly sales commentary without any table."],
    });

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(result.status).toBe("failed");
    expect(task?.lastError).toContain("No spreadsheet data was found");
    expect(ai.calls.map((call) => call.key)).toEqual(["coordinator"]);
  });
});

describe("buildDataAnalystTaskOutput", () => {
  it("always produces a dashboard, charting the total when there are no dates or categories", async () => {
    const buffer = new TextEncoder().encode("Order ID,Amount\nA-1,100\nA-2,250");
    const extraction = await extractFixtureAsync(
      buffer,
      fixtureMetadata("doc", "orders.csv", CSV_MIME, buffer.byteLength),
    );
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "orders.csv",
      table: extraction.tables[0] as ExtractedTable,
    });
    const output = buildDataAnalystTaskOutput(
      analysis,
      dataAnalystOutputSchema.parse({ summary: "Sales were {{total-amount}}." }),
      { usage: { input: 10, output: 5, total: 15 }, cost: 0 },
    );
    const charts = (output.sections ?? []).filter((item) => item.kind === "chart");

    expect(output.deliverables).toEqual([
      { key: "dashboard", title: "Dashboard", format: "dashboard" },
    ]);
    expect(charts).toHaveLength(1);
    expect(JSON.parse(charts[0]?.content ?? "{}")).toMatchObject({
      id: "chart-total",
      type: "bar",
      data: [{ measure: "Total Amount", total: 350 }],
    });
    expect(output.sections?.find((item) => item.title === "Anomalies")?.content).toBe(
      "Not screened for anomalies: there are no dated amounts to group by month.",
    );
  });
});
describe("data analyst registration", () => {
  it("is the default handler and agent for the business-data-analyst role", () => {
    const registry = createAgentRegistry();

    expect(createDefaultTaskHandlers().get("business-data-analyst")).toBeDefined();
    expect(isDataAnalystAgent(registry.get("business-data-analyst"))).toBe(true);
    expect(registry.get("business-data-analyst")?.profile).toMatchObject({
      role: "business-data-analyst",
      modelTier: "mid",
      outputFormats: ["report", "dashboard"],
    });
  });
});
