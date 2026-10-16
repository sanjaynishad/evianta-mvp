import type { Finding } from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  checkNumericClaims,
  recomputeTotal,
  runDeterministicChecks,
  type VerificationFinding,
} from "./verification.js";

const evidence = [
  { id: "ev-1", sourceRef: "26AS p.2", description: "TDS credit", documentId: "doc-1" },
];

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, "id" | "taskId">,
): VerificationFinding {
  return {
    summary: `Finding ${overrides.id}`,
    severity: "medium",
    evidence,
    ...overrides,
  };
}

describe("deterministic checks", () => {
  it("passes a consistent, evidenced case", () => {
    const findings = [
      makeFinding({
        id: "f-1",
        taskId: "reconcile",
        figures: [
          {
            key: "tds-mismatch",
            label: "TDS mismatch",
            value: 12400,
            components: [
              { label: "TDS per 26AS", value: 48400 },
              { label: "TDS claimed", value: -36000 },
            ],
          },
        ],
        dates: [{ key: "notice-date", label: "Notice date", date: "2025-08-14" }],
      }),
      makeFinding({
        id: "f-2",
        taskId: "draft",
        figures: [{ key: "tds-mismatch", label: "TDS mismatch", value: 12400 }],
        dates: [{ key: "notice-date", label: "Notice date", date: "2025-08-14T00:00:00Z" }],
      }),
      makeFinding({ id: "f-3", taskId: "draft", severity: "info", evidence: [] }),
    ];

    const report = runDeterministicChecks(findings);

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checkedClaims).toBe(1);
  });

  it("catches a wrong total", () => {
    const report = runDeterministicChecks([
      makeFinding({
        id: "f-1",
        taskId: "payments",
        figures: [
          {
            key: "outstanding",
            label: "Outstanding amount",
            value: 75000,
            components: [
              { label: "Invoice 101", value: 50000 },
              { label: "Invoice 102", value: 50000 },
              { label: "Payment", value: -30000 },
            ],
          },
        ],
      }),
    ]);

    expect(report.passed).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      check: "numeric-total",
      severity: "high",
      key: "outstanding",
      findingIds: ["f-1"],
      taskIds: ["payments"],
    });
    expect(report.issues[0]?.message).toContain("70,000");
  });

  it("catches a material finding without evidence", () => {
    const report = runDeterministicChecks([
      makeFinding({ id: "f-1", taskId: "analysis", severity: "high", evidence: [] }),
      makeFinding({ id: "f-2", taskId: "analysis", severity: "low", evidence: [] }),
    ]);

    expect(report.issues).toEqual([
      expect.objectContaining({
        check: "evidence-presence",
        severity: "high",
        findingIds: ["f-1"],
      }),
    ]);
  });

  it("catches inconsistent figures and dates across tasks", () => {
    const report = runDeterministicChecks([
      makeFinding({
        id: "f-1",
        taskId: "analysis",
        figures: [{ key: "demand", label: "Demand", value: 48210 }],
        dates: [{ key: "due-date", label: "Response due", date: "2025-09-01" }],
      }),
      makeFinding({
        id: "f-2",
        taskId: "draft",
        figures: [{ key: "demand", label: "Demand", value: 48120 }],
        dates: [{ key: "due-date", label: "Response due", date: "2025-09-10" }],
      }),
    ]);

    expect(report.issues.map((issue) => issue.check)).toEqual([
      "figure-consistency",
      "date-consistency",
    ]);
    expect(report.issues[0]?.taskIds).toEqual(["analysis", "draft"]);
  });

  it("runs additional checks and the generic claim checker", () => {
    expect(
      recomputeTotal([
        { label: "a", value: 0.1 },
        { label: "b", value: 0.2 },
      ]),
    ).toBe(0.3);
    expect(
      checkNumericClaims([
        { key: "k", label: "Total", claimed: 10, components: [{ label: "a", value: 10.004 }] },
      ]),
    ).toEqual([]);

    const report = runDeterministicChecks([], {
      additionalChecks: [
        () => [
          { check: "custom", severity: "low", message: "Custom", findingIds: [], taskIds: [] },
        ],
      ],
    });

    expect(report.issues.map((issue) => issue.check)).toEqual(["custom"]);
  });
});
