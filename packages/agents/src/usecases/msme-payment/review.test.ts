import type { Case, Task } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";

import type { TaskExecutionContext, TaskHandler, UpstreamSection } from "../../handlers.js";
import type { VerificationFinding } from "../../verification.js";
import { reconcileMsmeFixtureAsync } from "../../testing/msmePayment.js";
import { quotedDates } from "./dates.js";
import {
  chronologyOrderCheck,
  createMsmePaymentReviewTaskHandler,
  expectedPaymentFigures,
  outstandingRecomputeCheck,
  quotedAmountsCheck,
  quotedDatesCheck,
  quotedRupeeAmounts,
} from "./review.js";

function section(title: string, content: string): UpstreamSection {
  return {
    taskId: "task-prep",
    taskTitle: "Prepare the case pack",
    role: "case-preparation",
    deliverableId: "deliverable-primary",
    title,
    content,
  };
}

function finding(overrides: Partial<VerificationFinding>): VerificationFinding {
  return {
    id: "finding-1",
    taskId: "task-recon",
    summary: "Stated figure",
    severity: "info",
    evidence: [],
    ...overrides,
  };
}

describe("quoted amounts and dates", () => {
  it("reads rupee amounts in common forms", () => {
    expect(
      quotedRupeeAmounts("Rs 1,87,000 and Rs. 50,000/- plus ₹75,000 and INR 5,000.50").map(
        (amount) => amount.value,
      ),
    ).toEqual([187000, 50000, 75000, 5000.5]);
  });

  it("reads ISO, day-first, and named-month dates", () => {
    expect(
      quotedDates(
        "On 2025-03-31, 20/12/2024, 31 March 2025, 5th Feb 2025, and March 9, 2025; not 2025-02-30.",
      ).map((date) => date.iso),
    ).toEqual(["2025-03-31", "2024-12-20", "2025-03-31", "2025-02-05", "2025-03-09"]);
  });
});

describe("MSME review checks", () => {
  it("flags a stated outstanding figure that does not match the recomputation", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const check = outstandingRecomputeCheck(expectedPaymentFigures(reconciliation), () => true);
    const issues = check([
      finding({
        figures: [
          { key: "outstanding:INV1002", label: "INV-1002 outstanding", value: 90000 },
          { key: "outstanding:INV1003", label: "INV-1003 outstanding", value: 62000 },
        ],
      }),
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        check: "payment-recompute",
        severity: "high",
        message:
          '"INV-1002 outstanding" is stated as 90,000 but recomputing it from the invoice register and payment records gives 50,000.',
      }),
    ]);
  });

  it("accepts amounts that come from records and flags ones that do not", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const check = quotedAmountsCheck(
      [
        section(
          "Proposed follow-up draft",
          "Rs 1,87,000 is due; Rs 60,000 was paid; Rs 12,345 is new.",
        ),
      ],
      expectedPaymentFigures(reconciliation),
      reconciliation,
    );

    expect(check([]).map((issue) => issue.message)).toEqual([
      '"Proposed follow-up draft" quotes Rs 12,345, which does not match any computed or sourced figure (closest: 5,000).',
    ]);
  });

  it("does not accept a rupee amount that only matches a figure in days", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const check = quotedAmountsCheck(
      [section("Proposed follow-up draft", "Interest of Rs 60 is due.")],
      expectedPaymentFigures(reconciliation),
      reconciliation,
    );
    const issues = check([
      finding({
        taskId: "task-documents",
        figures: [{ key: "agreed-credit-days", label: "Credit period", value: 60, unit: "days" }],
      }),
    ]);

    expect(issues.map((issue) => issue.key)).toEqual(["amount:60"]);
  });

  it("flags dates that are not in the records or findings", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const check = quotedDatesCheck(
      [section("Chronology", "2024-10-15  Invoice raised\n2025-02-05  Email\n2025-02-06  Call")],
      reconciliation,
    );
    const issues = check([
      finding({ dates: [{ key: "event:correspondence:-:1", label: "Email", date: "2025-02-05" }] }),
    ]);

    expect(issues.map((issue) => [issue.check, issue.key])).toEqual([
      ["quoted-date", "date:2025-02-06"],
    ]);
  });

  it("flags a chronology that is out of order", () => {
    const issues = chronologyOrderCheck([
      section("Chronology", "2024-10-15  Invoice\n2024-09-01  Order\n2024-11-01  Delivery"),
    ])([]);

    expect(issues[0]).toMatchObject({ check: "chronology-order", severity: "medium" });
  });

  it("defers to the fallback reviewer for other use cases", async () => {
    const fallback: TaskHandler = {
      role: "independent-review",
      executeAsync: vi.fn(async () => ({
        findings: [],
        usage: { input: 0, output: 0, total: 0 },
        cost: 0,
      })),
    };
    const handler = createMsmePaymentReviewTaskHandler({ fallback });
    const ctx = {
      case: { id: "case-1", useCase: "tax-notice" } as Case,
      task: { id: "task-review" } as Task,
    } as TaskExecutionContext;

    await handler.executeAsync(ctx);

    expect(fallback.executeAsync).toHaveBeenCalledWith(ctx);
  });
});
