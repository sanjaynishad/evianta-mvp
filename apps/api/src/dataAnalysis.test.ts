import { parseChartSpecContent } from "@evianta/core";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { asText, createTestHarness, sseFramesOf, VISITOR_A } from "./testing/harness.js";

const SALES_ROWS = [
  "Order ID,Order Date,Region,Product,Quantity,Amount (INR)",
  "SO-1,2024-01-05,North,Widget,10,2500",
  "SO-2,2024-01-19,South,Gadget,5,7500",
  "SO-3,2024-02-02,North,Widget,12,3000",
  "SO-4,2024-02-16,South,Gadget,6,8000",
  "SO-5,15/03/2024,North,Widget,14,3500",
  "SO-6,03/22/2024,South,Gadget,7,8500",
  "SO-7,2024-04-05,North,Widget,40,10000",
  "SO-8,2024-04-12,South,Gadget,25,20000",
  "SO-9,2024-05-03,North,Widget,16,4000",
  "SO-10,2024-05-10,South,Gadget,9,10000",
  "SO-10,2024-05-10,South,Gadget,9,10000",
  "SO-11,2024-06-07,,Widget,18,4500",
  "SO-12,2024-06-14,South,Gadget,10,pending",
  "SO-13,2024-06-21,South,Gadget,10,10500",
];

const analystOutput = {
  summary: "Sales totalled {{total-amount}} over {{period-count}} months.",
  trends: "South led with {{segment-region-south-share-pct}} of sales.",
  anomalies: "April reached {{period-2024-04-total}}.",
  insights: [
    {
      summary: "April sales of {{period-2024-04-total}} sit above the trend",
      severity: "medium",
      metricIds: ["period-2024-04-total"],
      anomalyIds: ["anomaly-2024-04"],
    },
  ],
  assumptions: [],
  openQuestions: [],
};

describe("use case A over HTTP", () => {
  it("analyzes an uploaded CSV and serves the report and dashboard deliverables", async () => {
    const { app, ai } = createTestHarness({
      script: {
        coordinator: {
          output: {
            tasks: [
              {
                assignedRole: "business-data-analyst",
                title: "Analyze the sales data",
                dependsOn: [],
              },
            ],
          },
        },
        "business-data-analyst": { output: analystOutput, usage: { input: 3000, output: 500 } },
      },
    });
    const created = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", VISITOR_A)
      .send({ title: "H1 sales review", description: "Monthly sales", useCase: "data-analysis" })
      .expect(201);
    const caseId = created.body.id as string;
    const upload = await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", Buffer.from(SALES_ROWS.join("\n")), {
        filename: "sales.csv",
        contentType: "text/csv",
      })
      .expect(201);
    const documentId = upload.body.documents[0].id as string;

    await app.idleAsync();
    await request(app).post(`/cases/${caseId}/run`).expect(202);

    const stream = await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200);
    const frames = sseFramesOf(stream);

    expect(frames.at(-1)).toMatchObject({ event: "run-completed" });
    expect((frames.at(-1)?.data as { deliverableIds: string[] }).deliverableIds.sort()).toEqual([
      "deliverable-dashboard",
      "deliverable-primary",
    ]);
    expect(ai.calls.map((call) => call.key)).toEqual(["coordinator", "business-data-analyst"]);
    expect(ai.calls[1]?.prompt).not.toContain("SO-13");

    await app.idleAsync();

    const report = await request(app)
      .get(`/cases/${caseId}/deliverables/deliverable-primary`)
      .expect(200);
    const sections = report.body.sections as Array<{ title: string; content: string }>;

    expect(report.body.format).toBe("report");
    expect(sections.map((section) => section.title)).toEqual([
      "Summary",
      "Key metrics",
      "Trends",
      "Anomalies",
      "Data quality",
      "Assumptions and open questions",
    ]);
    expect(sections[0]?.content).toBe("Sales totalled ₹92,000 over 6 months.");
    expect(sections.find((section) => section.title === "Data quality")?.content).toContain(
      "| F14 |",
    );

    const dashboard = await request(app)
      .get(`/cases/${caseId}/deliverables/deliverable-dashboard`)
      .expect(200);
    const charts = (dashboard.body.sections as Array<{ kind: string; content: string }>).map(
      (section) => parseChartSpecContent(section.content),
    );

    expect(dashboard.body.format).toBe("dashboard");
    expect(charts.length).toBeGreaterThan(2);
    expect(charts.every((chart) => chart.success)).toBe(true);
    expect(charts[0]).toMatchObject({
      success: true,
      spec: {
        type: "line",
        data: [
          { month: "2024-01", total: 10000 },
          { month: "2024-02", total: 11000 },
          { month: "2024-03", total: 12000 },
          { month: "2024-04", total: 30000 },
          { month: "2024-05", total: 14000 },
          { month: "2024-06", total: 15000 },
        ],
      },
    });

    const state = await request(app).get(`/cases/${caseId}`).expect(200);
    const material = (
      state.body.findings as Array<{
        summary: string;
        severity?: string;
        figures?: unknown[];
        evidence: Array<{ documentId?: string; location?: { cellRange?: string } }>;
      }>
    ).filter(
      (finding) =>
        finding.severity === "high" ||
        finding.severity === "medium" ||
        (finding.figures?.length ?? 0) > 0,
    );

    expect(state.body.case.status).toBe("completed");
    expect(material.length).toBeGreaterThan(3);
    expect(
      material.every(
        (finding) =>
          finding.evidence.length > 0 &&
          finding.evidence.every(
            (item) => item.documentId === documentId && Boolean(item.location?.cellRange),
          ),
      ),
    ).toBe(true);
  });
});
