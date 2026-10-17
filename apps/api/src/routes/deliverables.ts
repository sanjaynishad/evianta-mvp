import { sectionReviewStatusSchema } from "@evianta/core";
import { Router } from "express";
import { z } from "zod";

import { loadActiveRecordAsync } from "../caseState.js";
import { getCaseOrThrowAsync, getMutableCaseAsync, type ApiContext } from "../context.js";
import { notFoundError } from "../errors.js";
import { exportDeliverableAsync, exportFormatSchema } from "../exports.js";
import {
  asyncRoute,
  contentDisposition,
  deliverableParamsSchema,
  sectionParamsSchema,
} from "../http.js";

const exportQuerySchema = z.object({ format: exportFormatSchema });

const sectionUpdateSchema = z
  .object({
    editedContent: z.string().max(200_000).nullable().optional(),
    reviewStatus: sectionReviewStatusSchema.optional(),
    reviewComment: z.string().trim().max(4000).nullable().optional(),
  })
  .strict()
  .refine((update) => Object.keys(update).length > 0, {
    message: "Send editedContent, reviewStatus, or reviewComment.",
  });

export function createDeliverableRoutes(ctx: ApiContext): Router {
  const router = Router();
  const { store } = ctx;

  async function getDeliverableOrThrowAsync(caseId: string, deliverableId: string) {
    const deliverable = await store.deliverables.getDeliverableAsync(caseId, deliverableId);

    if (!deliverable) {
      throw notFoundError("deliverable");
    }

    return deliverable;
  }

  router.get(
    "/cases/:caseId/deliverables/:deliverableId",
    asyncRoute(async (req, res) => {
      const { caseId, deliverableId } = deliverableParamsSchema.parse(req.params);

      await getCaseOrThrowAsync(ctx, caseId);
      res.json(await getDeliverableOrThrowAsync(caseId, deliverableId));
    }),
  );

  router.get(
    "/cases/:caseId/deliverables/:deliverableId/export",
    asyncRoute(async (req, res) => {
      const { caseId, deliverableId } = deliverableParamsSchema.parse(req.params);
      const { format } = exportQuerySchema.parse(req.query);
      const input = await ctx.approvals.runAsync(caseId, async () => {
        const caseRecord = await getCaseOrThrowAsync(ctx, caseId);
        const [deliverable, record, evidence] = await Promise.all([
          getDeliverableOrThrowAsync(caseId, deliverableId),
          loadActiveRecordAsync(store, caseId),
          store.evidence.getEvidenceForCaseAsync(caseId),
        ]);

        return {
          caseRecord,
          deliverable,
          findings: record.findings,
          evidence,
          generatedAt: ctx.now(),
        };
      });
      const file = await exportDeliverableAsync(format, input);

      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", contentDisposition("attachment", file.fileName));
      res.setHeader("Cache-Control", "no-store");
      res.send(file.body);
    }),
  );

  router.patch(
    "/cases/:caseId/deliverables/:deliverableId/sections/:sectionId",
    asyncRoute(async (req, res) => {
      const { caseId, deliverableId, sectionId } = sectionParamsSchema.parse(req.params);

      await getMutableCaseAsync(ctx, caseId);

      const update = sectionUpdateSchema.parse(req.body);

      await ctx.approvals.runAsync(caseId, async () => {
        await getDeliverableOrThrowAsync(caseId, deliverableId);
        res.json(
          await store.deliverables.updateSectionAsync(caseId, deliverableId, sectionId, update),
        );
      });
    }),
  );

  return router;
}
