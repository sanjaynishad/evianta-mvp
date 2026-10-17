import type { ChartSpecInput, CaseStateInput } from "@evianta/core";
import { extractionSummary } from "./documents";

const caseId = "sample-data-analysis";
const createdAt = "2026-09-29T04:30:00.000Z";
const finishedAt = "2026-09-29T04:36:40.000Z";

const salesFile = {
  id: "a-doc-sales",
  name: "northwind_sales_fy2026_q2.xlsx",
};

const monthlyNetSales: ChartSpecInput = {
  id: "chart-net-sales-by-month",
  type: "bar",
  title: "Net sales by month",
  description: "Net of returns and discounts, all regions.",
  categoryKey: "month",
  series: [
    { key: "netSales", label: "Net sales" },
    { key: "returns", label: "Returns" },
  ],
  data: [
    { month: "Jul 2025", netSales: 4210000, returns: 179210 },
    { month: "Aug 2025", netSales: 4625000, returns: 301220 },
    { month: "Sep 2025", netSales: 4980000, returns: 200800 },
  ],
  xAxis: { label: "Month" },
  yAxis: { label: "Amount", format: "currency-inr" },
  source: {
    aggregation: "Sum of net amount and returns by invoice month",
    documentId: salesFile.id,
    evidenceIds: ["a-ev-monthly-totals"],
  },
};

const returnRate: ChartSpecInput = {
  id: "chart-return-rate",
  type: "line",
  title: "Return rate by region",
  categoryKey: "month",
  series: [
    { key: "west", label: "West" },
    { key: "north", label: "North" },
    { key: "south", label: "South" },
  ],
  data: [
    { month: "Jul 2025", west: 0.041, north: 0.038, south: 0.044 },
    { month: "Aug 2025", west: 0.092, north: 0.04, south: 0.043 },
    { month: "Sep 2025", west: 0.039, north: 0.036, south: 0.041 },
  ],
  xAxis: { label: "Month" },
  yAxis: { label: "Returns as a share of gross sales", format: "percent" },
  source: {
    aggregation: "Returns divided by gross sales, by region and month",
    documentId: salesFile.id,
    evidenceIds: ["a-ev-west-returns"],
  },
};

const regionShare: ChartSpecInput = {
  id: "chart-region-share",
  type: "pie",
  title: "Share of net sales by region",
  categoryKey: "region",
  series: [{ key: "netSales", label: "Net sales" }],
  data: [
    { region: "West", netSales: 5320000 },
    { region: "North", netSales: 3910000 },
    { region: "South", netSales: 3640000 },
    { region: "Unassigned", netSales: 945000 },
  ],
  yAxis: { format: "currency-inr" },
  source: {
    aggregation: "Sum of net amount by customer region for the quarter",
    documentId: salesFile.id,
    evidenceIds: ["a-ev-monthly-totals", "a-ev-missing-region"],
  },
};

const cumulativeNetSales: ChartSpecInput = {
  id: "chart-cumulative-net-sales",
  type: "area",
  title: "Cumulative net sales, quarter to date",
  description: "Running total of monthly net sales across all regions.",
  categoryKey: "month",
  series: [{ key: "cumulativeNetSales", label: "Cumulative net sales" }],
  data: [
    { month: "Jul 2025", cumulativeNetSales: 4210000 },
    { month: "Aug 2025", cumulativeNetSales: 8835000 },
    { month: "Sep 2025", cumulativeNetSales: 13815000 },
  ],
  xAxis: { label: "Month" },
  yAxis: { label: "Amount", format: "currency-inr" },
  source: {
    aggregation: "Running sum of net amount by invoice month",
    documentId: salesFile.id,
    evidenceIds: ["a-ev-monthly-totals"],
  },
};

export const dataAnalysisChartSpecs = [
  monthlyNetSales,
  returnRate,
  cumulativeNetSales,
  regionShare,
];

export const dataAnalysisCaseState: CaseStateInput = {
  case: {
    id: caseId,
    title: "Quarterly sales review - Northwind Traders",
    description:
      "Review Q2 FY2026 sales by month, region, and product. Highlight growth, unusual returns, and data-quality problems.",
    useCase: "data-analysis",
    status: "completed",
    isSample: true,
    usage: {
      inputTokens: 18420,
      outputTokens: 4310,
      costEstimate: 0.0213,
      runCount: 1,
      lastRunAt: finishedAt,
    },
    createdAt,
    updatedAt: finishedAt,
  },
  documents: [
    {
      id: salesFile.id,
      caseId,
      name: salesFile.name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 482113,
      uploadedAt: "2026-09-29T04:31:10.000Z",
      status: "ready",
      extraction: extractionSummary("parse", 1),
    },
  ],
  tasks: [
    {
      id: "a-task-quality",
      caseId,
      title: "Check data quality",
      assignedRole: "business-data-analyst",
      status: "completed",
      attempts: 1,
      tokenUsage: { input: 3100, output: 620, total: 3720 },
      costEstimate: 0.0011,
    },
    {
      id: "a-task-metrics",
      caseId,
      title: "Compute sales metrics and trends",
      assignedRole: "business-data-analyst",
      status: "completed",
      dependsOn: ["a-task-quality"],
      attempts: 1,
      tokenUsage: { input: 5200, output: 1180, total: 6380 },
      costEstimate: 0.0052,
    },
    {
      id: "a-task-report",
      caseId,
      title: "Draft the report and dashboard",
      assignedRole: "business-data-analyst",
      status: "completed",
      dependsOn: ["a-task-metrics"],
      attempts: 1,
      tokenUsage: { input: 6020, output: 1890, total: 7910 },
      costEstimate: 0.0071,
    },
    {
      id: "a-task-review",
      caseId,
      title: "Independently review the findings",
      assignedRole: "independent-review",
      status: "completed",
      dependsOn: ["a-task-report"],
      attempts: 1,
      tokenUsage: { input: 4100, output: 620, total: 4720 },
      costEstimate: 0.0079,
    },
  ],
  findings: [
    {
      id: "a-finding-growth",
      taskId: "a-task-metrics",
      summary: "Net sales grew 18.3% from July to September",
      detail:
        "Net sales rose from 42.1 lakh in July to 49.8 lakh in September. The increase is broad based: every region grew, led by West.",
      severity: "info",
      confidence: "high",
      evidence: [
        {
          id: "a-ev-monthly-totals",
          sourceRef: salesFile.name,
          description: "Monthly totals of the net amount column",
          documentId: salesFile.id,
          location: { sheet: "Sales", cellRange: "H2:H1841" },
          confidence: "high",
        },
      ],
    },
    {
      id: "a-finding-west-returns",
      taskId: "a-task-metrics",
      summary: "West region returns more than doubled in August",
      detail:
        "Returns in West reached 9.2% of gross sales in August against about 4% in other months. 71% of West's August returns come from one distributor in Pune.",
      severity: "medium",
      confidence: "medium",
      evidence: [
        {
          id: "a-ev-west-returns",
          sourceRef: salesFile.name,
          description: "Return lines for the West region in August",
          excerpt: "RTN-0812 to RTN-0868, customer: Deccan Distributors, Pune",
          documentId: salesFile.id,
          location: { sheet: "Sales", rowRange: { start: 812, end: 868 } },
          confidence: "high",
        },
      ],
      assumptions: ["Credit notes dated in early September were counted in August returns."],
      openQuestions: [
        {
          id: "a-q-pune-batch",
          text: "Was the August return batch from the Pune distributor a one-off quality issue?",
          severity: "medium",
        },
      ],
    },
    {
      id: "a-finding-missing-region",
      taskId: "a-task-quality",
      summary: "142 rows have no customer region",
      detail:
        "These rows total 9.45 lakh of net sales. They are grouped as Unassigned in the regional view.",
      severity: "low",
      confidence: "high",
      evidence: [
        {
          id: "a-ev-missing-region",
          sourceRef: salesFile.name,
          description: "Rows where the region column is blank",
          documentId: salesFile.id,
          location: { sheet: "Sales", cellRange: "E2:E1841" },
          confidence: "high",
        },
      ],
      assumptions: ["Rows with no region are grouped as Unassigned."],
      openQuestions: [
        {
          id: "a-q-region-master",
          text: "Can a customer master be shared to fill the missing regions?",
          severity: "low",
        },
      ],
    },
  ],
  deliverables: [
    {
      id: "a-deliverable-report",
      caseId,
      title: "Sales review report",
      format: "report",
      sections: [
        {
          id: "a-section-summary",
          title: "Summary",
          kind: "text",
          content:
            "Net sales grew 18.3% across the quarter, with every region contributing.\n\nThe main exception is a spike in West region returns in August, concentrated in one distributor. 142 rows lack a customer region and are shown as Unassigned.",
          producedByRole: "business-data-analyst",
          modelTier: "mid",
          findingIds: ["a-finding-growth", "a-finding-west-returns", "a-finding-missing-region"],
          evidenceIds: ["a-ev-monthly-totals", "a-ev-west-returns"],
        },
        {
          id: "a-section-returns",
          title: "Returns in the West region",
          kind: "text",
          content:
            "Returns in West reached 9.2% of gross sales in August. Most of the value traces to return notes RTN-0812 to RTN-0868 from Deccan Distributors, Pune.\n\nRecommended next step: confirm with the distributor whether the batch was a one-off quality issue before adjusting the forecast.",
          producedByRole: "business-data-analyst",
          modelTier: "mid",
          findingIds: ["a-finding-west-returns"],
          evidenceIds: ["a-ev-west-returns"],
        },
        {
          id: "a-section-quality",
          title: "Data quality",
          kind: "text",
          content:
            "142 of 1,840 rows have no customer region. Their net value is 9.45 lakh, about 7% of the quarter. Sharing a customer master would let the regional view assign them.",
          producedByRole: "independent-review",
          modelTier: "high",
          findingIds: ["a-finding-missing-region"],
          evidenceIds: ["a-ev-missing-region"],
        },
      ],
    },
    {
      id: "a-deliverable-dashboard",
      caseId,
      title: "Sales dashboard",
      format: "dashboard",
      sections: dataAnalysisChartSpecs.map((spec) => ({
        id: `a-section-${spec.id}`,
        title: spec.title,
        kind: "chart" as const,
        content: JSON.stringify(spec),
        producedByRole: "business-data-analyst" as const,
        modelTier: "mid" as const,
        evidenceIds: spec.source?.evidenceIds ?? [],
      })),
    },
  ],
  run: { active: false, lastEventSeq: 0, lastRunId: "a-run-1", lastEventType: "run-completed" },
};
