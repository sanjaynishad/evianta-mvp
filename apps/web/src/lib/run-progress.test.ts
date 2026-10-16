import { describe, expect, it } from "vitest";
import { failedCaseState, fixtureFailure, failedRunEvents } from "@/fixtures";
import {
  applyRunEvent,
  canRetry,
  createRunProgress,
  getBlockedTasks,
  getFailedTasks,
} from "./run-progress";

describe("run progress", () => {
  it("derives failed and blocked steps from a failed case", () => {
    const progress = createRunProgress(failedCaseState);

    expect(progress.status).toBe("failed");
    expect(getFailedTasks(progress).map((task) => task.id)).toEqual([fixtureFailure.taskId]);
    expect(getBlockedTasks(progress)).toHaveLength(2);
    expect(progress.error).toBe(fixtureFailure.error);
    expect(canRetry(progress)).toBe(true);
  });

  it("marks blocked steps and announces a failure as events arrive", () => {
    const progress = failedRunEvents.reduce(applyRunEvent, {
      ...createRunProgress(failedCaseState),
      lastSeq: 0,
      runId: undefined,
    });

    expect(progress.status).toBe("failed");
    expect(getBlockedTasks(progress).map((task) => task.id)).toEqual([
      "c-task-prepare",
      "c-task-review",
    ]);
    expect(progress.announcement).toMatch(/^Run stopped/);
  });

  it("resets only the retried steps on a retry start and keeps earlier findings", () => {
    const failed = createRunProgress(failedCaseState);
    const retryIds = [fixtureFailure.taskId, "c-task-prepare", "c-task-review"];

    const retrying = applyRunEvent(failed, {
      type: "run-started",
      caseId: failedCaseState.case.id,
      runId: "retry-1",
      seq: failed.lastSeq + 1,
      timestamp: "2026-10-03T10:00:00.000Z",
      mode: "retry",
      taskIds: retryIds,
    });

    expect(retrying.status).toBe("running");
    expect(retrying.findings).toEqual(failed.findings);
    expect(
      retrying.tasks
        .filter((task) => retryIds.includes(task.id))
        .every((task) => task.status === "pending"),
    ).toBe(true);
    expect(retrying.tasks.find((task) => task.id === "c-task-documents")?.status).toBe("completed");
    expect(canRetry(retrying)).toBe(false);
  });
});
