import type { CaseState } from "@evianta/core";
import { describe, expect, it } from "vitest";
import {
  failedCaseState,
  fixtureFailure,
  failedRunEvents,
  getSampleStateForUseCase,
} from "@/fixtures";
import { buildRunEvents, failedRunMessage } from "@/fixtures/run-events";
import {
  applyRunEvent,
  canRetry,
  createReplayProgress,
  createRunProgress,
  getBlockedTasks,
  getFailedTasks,
  runStoppedMessage,
} from "./run-progress";

describe("run progress", () => {
  it("derives failed and blocked steps from a failed case", () => {
    const progress = createRunProgress(failedCaseState);

    expect(progress.status).toBe("failed");
    expect(getFailedTasks(progress).map((task) => task.id)).toEqual([fixtureFailure.taskId]);
    expect(getBlockedTasks(progress)).toHaveLength(2);
    expect(progress.error).toBe(failedRunMessage);
    expect(getFailedTasks(progress)[0]?.lastError).toBe(fixtureFailure.error);
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

  it("replays a retry run without discarding the steps it reused", () => {
    const sample = getSampleStateForUseCase("msme-payment");
    const retryIds = [fixtureFailure.taskId, "c-task-prepare", "c-task-review"];
    const state: CaseState = {
      ...sample,
      run: {
        active: false,
        lastEventSeq: 20,
        lastRunId: "retry-1",
        lastEventType: "run-completed",
      },
    };
    const events = buildRunEvents(state, {
      runId: "retry-1",
      mode: "retry",
      taskIds: retryIds,
      startSeq: 1,
    });

    const replayed = events.reduce(applyRunEvent, createReplayProgress(state));

    expect(replayed.status).toBe("completed");
    expect(replayed.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(new Set(replayed.findings.map((finding) => finding.id))).toEqual(
      new Set(state.findings.map((finding) => finding.id)),
    );
  });

  it("clears the board when a replayed normal run starts", () => {
    const sample = getSampleStateForUseCase("data-analysis");
    const [runStarted] = buildRunEvents(sample, { runId: "replay-1" });

    const replay = applyRunEvent(createReplayProgress(sample), runStarted!);

    expect(replay.tasks.every((task) => task.status === "pending")).toBe(true);
    expect(replay.findings).toEqual([]);
  });

  it("derives status from the run cursor and explains a run that stopped outside a step", () => {
    const sample = getSampleStateForUseCase("data-analysis");
    const failedRun = {
      active: false,
      lastEventSeq: 3,
      lastRunId: "run-9",
      lastEventType: "run-failed" as const,
    };
    const running = createRunProgress({ ...sample, run: { ...sample.run, active: true } });
    const stopped = createRunProgress({
      ...sample,
      run: {
        ...failedRun,
        lastRunError:
          "Text recognition is not available right now. It is retried when the case runs.",
      },
    });
    const withoutMessage = createRunProgress({ ...sample, run: failedRun });

    expect(running.status).toBe("running");
    expect(stopped.status).toBe("failed");
    expect(stopped.mode).toBe("run");
    expect(getFailedTasks(stopped)).toEqual([]);
    expect(stopped.error).toMatch(/^Text recognition is not available/);
    expect(withoutMessage.error).toBe(runStoppedMessage);
  });

  it("reads the mode of the last run", () => {
    const sample = getSampleStateForUseCase("data-analysis");

    expect(
      createRunProgress({ ...sample, run: { ...sample.run, lastRunMode: "retry" } }).mode,
    ).toBe("retry");
  });
});
