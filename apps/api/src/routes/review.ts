import { askCaseAsync } from "@evianta/agents";
import { AiError } from "@evianta/ai";
import type { TokenUsage } from "@evianta/core";
import { Router } from "express";
import { z } from "zod";

import { loadActiveRecordAsync } from "../caseState.js";
import { getCaseOrThrowAsync, getMutableCaseAsync, type ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { asyncRoute, caseParamsSchema, questionParamsSchema } from "../http.js";
import { messageOf } from "../logger.js";
import { openEventStream } from "../sse.js";

const noteSchema = z.string().trim().min(1).max(4000);

const noteBodySchema = z.object({ note: noteSchema.optional() }).strict();

const askSchema = z.object({ question: z.string().trim().min(1).max(2000) }).strict();

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const WORDS_PER_DELTA = 6;

export function chunkAnswer(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];

  for (let index = 0; index < words.length; index += WORDS_PER_DELTA) {
    chunks.push(words.slice(index, index + WORDS_PER_DELTA).join(""));
  }

  return chunks;
}

export function createReviewRoutes(ctx: ApiContext): Router {
  const router = Router();
  const { store } = ctx;

  for (const action of ["resolve", "dismiss"] as const) {
    router.post(
      `/cases/:caseId/open-questions/:questionId/${action}`,
      asyncRoute(async (req, res) => {
        const { caseId, questionId } = questionParamsSchema.parse(req.params);

        await getMutableCaseAsync(ctx, caseId);

        const { note } = noteBodySchema.parse(req.body ?? {});
        const finding = await store.findings.updateOpenQuestionAsync(caseId, questionId, {
          status: action === "resolve" ? "resolved" : "dismissed",
          ...(note ? { resolutionNote: note } : {}),
        });

        res.json({ finding });
      }),
    );
  }

  router.post(
    "/cases/:caseId/approve",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);

      await getMutableCaseAsync(ctx, caseId);

      const { note } = noteBodySchema.parse(req.body ?? {});

      if (ctx.runs.isActive(caseId)) {
        throw new ApiError(409, "run-in-progress", "Wait for the run to finish before approving.");
      }

      const { findings } = await loadActiveRecordAsync(store, caseId);
      const unresolvedQuestions = findings
        .flatMap((finding) => finding.openQuestions)
        .filter((question) => question.status === "open")
        .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
      const unresolvedQuestionIds = unresolvedQuestions.map((question) => question.id);
      const approved = await store.cases.recordApprovalAsync(caseId, {
        unresolvedQuestionIds,
        approvedAt: ctx.now().toISOString(),
        ...(note ? { note } : {}),
      });

      res.json({ case: approved, unresolvedQuestions });
    }),
  );

  router.post(
    "/cases/:caseId/ask",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const { question } = askSchema.parse(req.body);

      await getCaseOrThrowAsync(ctx, caseId);

      const writer = openEventStream(res);
      const recordUsageAsync = async (usage: TokenUsage, cost: number) => {
        if (usage.total <= 0 && cost <= 0) {
          return;
        }

        try {
          await store.cases.updateCaseUsageAsync(caseId, {
            inputTokens: usage.input,
            outputTokens: usage.output,
            costEstimate: cost,
          });
        } catch (error) {
          ctx.logger.warn("Could not record case assistant usage.", {
            caseId,
            error: messageOf(error),
          });
        }
      };

      try {
        const result = await askCaseAsync({ caseId, question }, { store, ai: ctx.ai });

        await recordUsageAsync(result.usage, result.cost);

        const text = result.status === "answered" ? result.answer : result.message;

        for (const chunk of chunkAnswer(text)) {
          writer.send("answer-delta", { text: chunk });
        }

        writer.send("answer", result);
      } catch (error) {
        ctx.logger.warn("Case assistant failed.", { caseId, error: messageOf(error) });

        if (error instanceof AiError) {
          await recordUsageAsync(error.usage, error.cost);
        }

        writer.send("error", {
          error: "ask-failed",
          message: "The assistant could not answer right now. Try again.",
        });
      } finally {
        writer.close();
      }
    }),
  );

  return router;
}
