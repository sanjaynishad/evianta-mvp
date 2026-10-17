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
import { MAX_COLUMN_NAME_CHARS } from "./columns.js";
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
  it("bounds source headers in prompts and persisted outputs while preserving inference and locations", async () => {
    const long = "x".repeat(300_000);
    const headers = [
      `${long} Amount (INR)`,
      `${long} Date`,
      `${long} Region`,
      `${long} Region extra`,
    ];
    const csv = [
      headers.join(","),
      "10,2024-01-01,North,Online",
      "20,2024-02-01,South,Retail",
      "pending,2024-03-01,North,Online",
    ].join("\n");
    const { result, ai, analysis, findings, deliverables } = await runSalesCaseAsync(
      { ...formats[0], bytes: () => Buffer.from(csv) },
      { summary: "Total {{total-amount}}." },
    );

    expect(result.status).toBe("completed");
    expect(analysis.source.table.columns.map((column) => column.name)).toEqual(headers);
    expect(analysis.roles.amount.index).toBe(0);
    expect(analysis.roles.date?.index).toBe(1);
    expect(analysis.roles.categories.map((column) => column.index)).toEqual([2, 3]);
    expect(analysis.currencyCode).toBe("INR");
    expect(analysis.metricsById.get("total-amount")?.value).toBe(30);
    expect(analysis.columns.every((column) => column.name.length <= MAX_COLUMN_NAME_CHARS)).toBe(
      true,
    );
    expect(new Set(analysis.columns.map((column) => column.name)).size).toBe(4);
    expect(ai.calls[1]?.prompt.length).toBeLessThan(100_000);
    expect(ai.calls[1]?.prompt).not.toContain(long);
    expect(JSON.stringify({ findings, deliverables }).length).toBeLessThan(150_000);
    expect(
      findings.flatMap((finding) => finding.evidence).map((item) => item.location?.cellRange),
    ).toContain("A4");
    expect(byFormat(deliverables, "dashboard")).toBeDefined();
  });

  it.each([
    ["undated", "Amount\n100\n200", "total-amount"],
    ["one month", "Date,Amount\n2024-01-01,100", "period-2024-01-total"],
    ["two months", "Date,Amount\n2024-01-01,100\n2024-02-01,200", "period-2024-02-total"],
    [
      "three months",
      "Date,Amount\n2024-01-01,100\n2024-02-01,200\n2024-03-01,300",
      "period-2024-03-total",
    ],
  ])(
    "persists an evidence-linked anomalies section for %s data with no anomalies",
    async (_name, csv, metricId) => {
      const { result, analysis, deliverables } = await runSalesCaseAsync(
        { ...formats[0], bytes: () => Buffer.from(csv) },
        { summary: "Sales.", anomalies: `Observed {{${metricId}}}.` },
      );
      const report = byFormat(deliverables, "report");
      const anomalies = section(report, "Anomalies");

      expect(analysis.anomalies).toEqual([]);
      expect(result.status).toBe("completed");
      expect(report).toBeDefined();
      expect(anomalies?.findingIds.length).toBeGreaterThan(0);
      expect(anomalies?.evidenceIds.length).toBeGreaterThan(0);
      expect(anomalies?.content).toContain("Observed");
    },
  );

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
    expect(anomaly?.evidence.map((item) => item.location?.cellRange)).toEqual([
      "G2:G29",
      "B2:B29",
      "A14:G17",
    ]);

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

describe("insight evidence", () => {
  it.each(["growth-first-to-last-pct", "average-monthly-change-pct"])(
    "cites date and amount columns for the two-month %s metric without a slope",
    async (metricId) => {
      const { result, analysis, findings } = await runSalesCaseAsync(
        {
          ...formats[0],
          bytes: () => Buffer.from("Date,Amount\n2024-01-01,100\n2024-02-01,200"),
        },
        {
          summary: "Sales.",
          insights: [
            {
              summary: `Change {{${metricId}}}.`,
              severity: "medium",
              metricIds: [metricId],
            },
          ],
        },
      );
      const insight = findings.find((finding) => finding.summary === "Change 100%.");

      expect(result.status).toBe("completed");
      expect(analysis.trend).toBeUndefined();
      expect(insight?.evidence.map((item) => item.location?.cellRange)).toEqual(["B2:B3", "A2:A3"]);
    },
  );

  it("cites both months for a month-over-month change", async () => {
    const buffer = new TextEncoder().encode(salesCsv());
    const extraction = await extractFixtureAsync(
      buffer,
      fixtureMetadata("doc", "sales.csv", CSV_MIME, buffer.byteLength),
    );
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "sales.csv",
      table: extraction.tables[0] as ExtractedTable,
    });
    const output = buildDataAnalystTaskOutput(
      analysis,
      dataAnalystOutputSchema.parse({
        summary: "Summary.",
        insights: [
          {
            summary: "February grew {{period-2024-02-change-pct}}",
            severity: "medium",
            metricIds: ["period-2024-02-change-pct"],
          },
        ],
      }),
      { usage: { input: 10, output: 5, total: 15 }, cost: 0 },
    );
    const insight = output.findings.find((finding) => finding.summary === "February grew 10%");

    expect(insight?.evidence?.map((item) => item.cellRange)).toEqual(["A2:G9"]);
  });
});

describe("section links", () => {
  async function outputFor(
    csv: string,
    summary: string,
    insights: DataAnalystOutputInput["insights"] = [],
  ) {
    const buffer = new TextEncoder().encode(csv);
    const extraction = await extractFixtureAsync(
      buffer,
      fixtureMetadata("doc", "data.csv", CSV_MIME, buffer.byteLength),
    );
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "data.csv",
      table: extraction.tables[0] as ExtractedTable,
    });

    return buildDataAnalystTaskOutput(
      analysis,
      dataAnalystOutputSchema.parse({ summary, insights }),
      {
        usage: { input: 10, output: 5, total: 15 },
        cost: 0,
      },
    );
  }

  it("links the summary to segment findings so shares keep their category evidence", async () => {
    const output = await outputFor(
      "Region,Amount\nNorth,10\nSouth,30\nSouth,20",
      "South holds {{segment-region-south-share-pct}}.",
    );
    const segment = output.findings.findIndex((finding) => finding.summary.startsWith("Region"));
    const summary = output.sections?.find((section) => section.title === "Summary");

    expect(segment).toBeGreaterThan(0);
    expect(summary?.findingIndexes).toContain(segment);
    expect(output.findings[segment]?.evidence?.map((item) => item.cellRange)).toEqual([
      "A2:A4",
      "B2:B4",
    ]);
  });

  it("uses complete column evidence when monthly rows exceed the evidence limit", async () => {
    const output = await outputFor(
      [
        "Date,Amount",
        "2024-01-01,1",
        "2024-02-01,10",
        "2024-01-02,1",
        "2024-03-01,10",
        "2024-01-03,1",
        "2024-04-01,10",
        "2024-01-04,1",
        "2024-05-01,10",
        "2024-01-05,1",
        "2024-06-01,10",
        "2024-01-06,1",
      ].join("\n"),
      "January total {{period-2024-01-total}}.",
      [
        {
          summary: "The complete January total is {{period-2024-01-total}}.",
          severity: "medium",
          metricIds: ["period-2024-01-total"],
        },
      ],
    );
    const finding = output.findings.find((item) => item.summary.startsWith("The complete January"));

    expect(finding?.evidence.map((item) => item.cellRange)).toEqual(["B2:B12", "A2:A12"]);
  });

  it("creates an evidence-linked finding for an Unassigned-only category breakdown", async () => {
    const output = await outputFor("Region,Amount\n,100\n,200\nNorth,pending", "Sales.");
    const findingIndex = output.findings.findIndex((item) =>
      item.summary.startsWith("Region Unassigned leads"),
    );
    const finding = output.findings[findingIndex];
    const chart = output.sections?.find(
      (item) => item.kind === "chart" && item.title.includes("Region"),
    );

    expect(finding?.evidence.map((item) => item.cellRange)).toEqual(["A2:A4", "B2:B4"]);
    expect(chart?.findingIndexes).toContain(findingIndex);
  });

  it("links the trends section to the overview when there is a single month", async () => {
    const output = await outputFor("Date,Amount\n2024-01-05,10\n2024-01-09,20", "Sales.");
    const trends = output.sections?.find((section) => section.title === "Trends");
    const overview = output.findings[0];

    expect(trends?.findingIndexes).toEqual([0]);
    expect(overview?.figures?.find((figure) => figure.key === "period-count")?.unit).toBe("months");
    expect(overview?.figures?.find((figure) => figure.key === "rows-analyzed")?.unit).toBe("rows");
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
