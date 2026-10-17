import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskProgress } from "@/lib/run-progress";
import { FailurePanel } from "./failure-panel";

const failedTask: TaskProgress = {
  id: "t1",
  title: "Reconcile payments",
  assignedRole: "reconciliation",
  status: "failed",
  dependsOn: [],
  attempts: 1,
  lastError: "The ledger could not be read.",
  findingIds: [],
};

describe("FailurePanel", () => {
  it("explains a run that stopped without a failed step and offers no retry", () => {
    render(
      <FailurePanel
        failedTasks={[]}
        blockedTasks={[]}
        runError="Planning did not finish. Try again."
        runFailed
        canRetry={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "The run stopped" })).toBeInTheDocument();
    expect(screen.getByTestId("run-error")).toHaveTextContent("Planning did not finish");
    expect(screen.queryByRole("button", { name: /Retry failed steps/ })).not.toBeInTheDocument();
  });

  it("renders nothing when nothing failed", () => {
    const { container } = render(
      <FailurePanel failedTasks={[]} blockedTasks={[]} canRetry={false} onRetry={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a failed step's error once", () => {
    render(
      <FailurePanel
        failedTasks={[failedTask]}
        blockedTasks={[]}
        runError={failedTask.lastError}
        runFailed
        canRetry
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "A step failed" })).toBeInTheDocument();
    expect(screen.getAllByText("The ledger could not be read.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Retry failed steps/ })).toBeEnabled();
  });
});
