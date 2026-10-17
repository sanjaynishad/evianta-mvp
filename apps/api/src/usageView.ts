import { roundCost } from "@evianta/ai";
import type { Case, IntakeMode, IntakeModeTotals, UseCase } from "@evianta/core";
import type { Store } from "@evianta/store";
import { Router } from "express";
import { z } from "zod";

import { asyncRoute } from "./http.js";

export interface UsageCaseRow {
  id: string;
  title: string;
  useCase?: UseCase;
  intakeMode?: IntakeMode;
  status: Case["status"];
  visitorId?: string;
  isSample: boolean;
  isCopy: boolean;
  sourceCaseId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  approved: boolean;
  documentCount: number;
  runCount: number;
  tokenUsage: { input: number; output: number; total: number };
  costEstimate: number;
}

export interface UsageTotals {
  cases: number;
  samples: number;
  copies: number;
  runs: number;
  visitors: number;
  tokenUsage: { input: number; output: number; total: number };
  costEstimate: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  /** Keyed by use case, plus "unspecified" when a case has none. */
  byUseCase: Record<string, UsageTotals>;
  /** Keyed by entry mode, plus "unspecified" for cases from before entry modes existed. */
  byIntakeMode: Record<string, IntakeModeTotals>;
}

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

const SUMMARY_PAGE_SIZE = 100;

function emptyTotals(): UsageTotals & { visitorIds: Set<string> } {
  return {
    cases: 0,
    samples: 0,
    copies: 0,
    runs: 0,
    visitors: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    costEstimate: 0,
    visitorIds: new Set(),
  };
}

function addCase(totals: ReturnType<typeof emptyTotals>, item: Case): void {
  const input = item.usage?.inputTokens ?? 0;
  const output = item.usage?.outputTokens ?? 0;

  totals.cases += 1;
  totals.samples += item.isSample ? 1 : 0;
  totals.copies += item.sourceCaseId ? 1 : 0;
  totals.runs += item.usage?.runCount ?? 0;
  totals.tokenUsage.input += input;
  totals.tokenUsage.output += output;
  totals.tokenUsage.total += input + output;
  totals.costEstimate = roundCost(totals.costEstimate + (item.usage?.costEstimate ?? 0));

  if (item.visitorId) {
    totals.visitorIds.add(item.visitorId);
  }
}

function addIntakeMode(byIntakeMode: Map<string, IntakeModeTotals>, item: Case): void {
  if (item.isSample) {
    return;
  }

  const key = item.intake?.mode ?? "unspecified";
  const bucket = byIntakeMode.get(key) ?? { cases: 0, submitted: 0, switchedIn: 0 };

  bucket.cases += 1;
  bucket.submitted += (item.usage?.runCount ?? 0) > 0 || item.intake?.stage === "submitted" ? 1 : 0;
  bucket.switchedIn += item.intake?.switchedFrom ? 1 : 0;
  byIntakeMode.set(key, bucket);
}

function finalize({ visitorIds, ...totals }: ReturnType<typeof emptyTotals>): UsageTotals {
  return { ...totals, visitors: visitorIds.size };
}

async function toRowAsync(store: Store, item: Case): Promise<UsageCaseRow> {
  const documents = await store.documents.getDocumentsForCaseAsync(item.id);
  const input = item.usage?.inputTokens ?? 0;
  const output = item.usage?.outputTokens ?? 0;

  return {
    id: item.id,
    title: item.title,
    ...(item.useCase ? { useCase: item.useCase } : {}),
    ...(item.intake ? { intakeMode: item.intake.mode } : {}),
    status: item.status,
    ...(item.visitorId ? { visitorId: item.visitorId } : {}),
    isSample: item.isSample,
    isCopy: Boolean(item.sourceCaseId),
    ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.usage?.lastRunAt ? { lastRunAt: item.usage.lastRunAt } : {}),
    approved: Boolean(item.approval),
    documentCount: documents.length,
    runCount: item.usage?.runCount ?? 0,
    tokenUsage: { input, output, total: input + output },
    costEstimate: item.usage?.costEstimate ?? 0,
  };
}

/**
 * The unlisted usage view for the platform owner. It is an obscure path, not authentication, so it
 * returns metadata only: no document contents, findings, or download links.
 */
export function createUsageViewRouter(store: Store): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/cases",
    asyncRoute(async (req, res) => {
      const query = pageQuerySchema.parse(req.query);
      const page = await store.cases.listAllCasesAsync({
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });

      res.json({
        cases: await Promise.all(page.cases.map((item) => toRowAsync(store, item))),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }),
  );

  router.get(
    "/summary",
    asyncRoute(async (_req, res) => {
      const overall = emptyTotals();
      const byUseCase = new Map<UseCase | "unspecified", ReturnType<typeof emptyTotals>>([
        ["data-analysis", emptyTotals()],
        ["tax-notice", emptyTotals()],
        ["msme-payment", emptyTotals()],
      ]);
      const byIntakeMode = new Map<string, IntakeModeTotals>([
        ["chat", { cases: 0, submitted: 0, switchedIn: 0 }],
        ["form", { cases: 0, submitted: 0, switchedIn: 0 }],
      ]);
      let cursor: string | undefined;

      do {
        const page = await store.cases.listAllCasesAsync({
          limit: SUMMARY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });

        for (const item of page.cases) {
          const key = item.useCase ?? "unspecified";
          let bucket = byUseCase.get(key);

          if (!bucket) {
            bucket = emptyTotals();
            byUseCase.set(key, bucket);
          }

          addCase(overall, item);
          addCase(bucket, item);
          addIntakeMode(byIntakeMode, item);
        }

        cursor = page.nextCursor;
      } while (cursor);

      const summary = {
        totals: finalize(overall),
        byUseCase: Object.fromEntries(
          [...byUseCase].map(([key, totals]) => [key, finalize(totals)]),
        ),
        byIntakeMode: Object.fromEntries(byIntakeMode),
      } as UsageSummary;

      res.json(summary);
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not-found", message: "Not found." });
  });

  return router;
}
