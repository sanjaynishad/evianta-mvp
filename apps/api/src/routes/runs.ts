import type { RunMode } from "@evianta/agents";
import type { Case, Task, TaskStatus } from "@evianta/core";
import { Router } from "express";

import { getMutableCaseAsync, type ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { asyncRoute, caseParamsSchema } from "../http.js";
import { streamRunEventsAsync } from "../runStream.js";

const RETRYABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["failed", "blocked", "in-progress"]);

// Mirrors the orchestrator's own check so a retry with nothing to do is rejected before 202.
function hasRetryableWork(caseRecord: Case, tasks: readonly Task[]): boolean {
  if (tasks.some((task) => RETRYABLE_STATUSES.has(task.status))) {
    return true;
  }

  return (
    tasks.length > 0 &&
    tasks.every((task) => task.status === "completed") &&
    caseRecord.status !== "completed"
  );
}

export function createRunRoutes(ctx: ApiContext): Router {
  const router = Router();

  async function startAsync(caseId: string, mode: RunMode) {
    if (ctx.approvals.isActive(caseId)) {
      throw new ApiError(
        409,
        "approval-in-progress",
        "Wait for the approval to finish before running.",
      );
    }

    return ctx.approvals.runAsync(caseId, async () => {
      const caseRecord = await getMutableCaseAsync(ctx, caseId);

      if (!caseRecord.useCase) {
        throw new ApiError(422, "use-case-missing", "The case has no use case to plan from.");
      }

      if (mode === "retry") {
        const tasks = await ctx.store.tasks.getTasksForCaseAsync(caseId);

        if (!ctx.runs.isActive(caseId) && !hasRetryableWork(caseRecord, tasks)) {
          throw new ApiError(409, "nothing-to-retry", "The case has no failed or blocked tasks.");
        }
      }

      if (ctx.runs.isActive(caseId)) {
        throw new ApiError(409, "run-in-progress", "This case already has a run in progress.");
      }

      if (ctx.uploads.isActive(caseId)) {
        throw new ApiError(
          409,
          "upload-in-progress",
          "Wait for the upload to finish before running.",
        );
      }

      await ctx.store.cases.clearApprovalAsync(caseId);

      if (ctx.runs.isActive(caseId)) {
        throw new ApiError(409, "run-in-progress", "This case already has a run in progress.");
      }

      if (ctx.uploads.isActive(caseId)) {
        throw new ApiError(
          409,
          "upload-in-progress",
          "Wait for the upload to finish before running.",
        );
      }

      const started = ctx.runs.start(caseId, mode);

      return {
        caseId,
        runId: started.runId,
        mode: started.mode,
        streamUrl: `/cases/${encodeURIComponent(caseId)}/stream`,
      };
    });
  }

  router.post(
    "/cases/:caseId/run",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);

      res.status(202).json(await startAsync(caseId, "run"));
    }),
  );

  router.post(
    "/cases/:caseId/retry",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);

      res.status(202).json(await startAsync(caseId, "retry"));
    }),
  );

  router.get(
    "/cases/:caseId/stream",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);

      await streamRunEventsAsync(req, res, caseId, {
        store: ctx.store,
        events: ctx.events,
        runs: ctx.runs,
        logger: ctx.logger,
        heartbeatMs: ctx.config.sseHeartbeatMs,
      });
    }),
  );

  return router;
}
