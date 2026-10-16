import type { AgentRole, Finding } from "@evianta/core";
import { LOW_CONFIDENCE_THRESHOLD, pagesNeedingReview } from "@evianta/ingest";

import type { Agent, AgentResult } from "../../agent.js";
import {
  createAgentTaskHandler,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
} from "../../handlers.js";
import { MSME_DATE_KEYS } from "./constants.js";
import { toIsoDate } from "./dates.js";
import { readPaymentRecords, type PaymentCaseDocument, type PaymentRecordSet } from "./records.js";
import {
  reconcilePayments,
  type PaymentReconcileOptions,
  type PaymentReconciliation,
} from "./reconcile.js";
import { resolveCreditTerms, type CreditTermsResolution } from "./terms.js";

type DocumentAccess = Pick<TaskExecutionContext, "documentMetadata" | "loadExtractionAsync">;

export async function loadPaymentCaseDocumentsAsync(
  ctx: DocumentAccess,
): Promise<PaymentCaseDocument[]> {
  return Promise.all(
    ctx.documentMetadata.map(async (metadata) => ({
      metadata,
      extraction: await ctx.loadExtractionAsync(metadata.id),
    })),
  );
}

/** The as-of date stated by an upstream reconciliation, so every task in a run uses the same one. */
export function upstreamAsOfDate(findings: readonly Finding[]): string | undefined {
  for (const finding of findings) {
    const entry = finding.dates?.find((date) => date.key === MSME_DATE_KEYS.asOfDate);
    const parsed = toIsoDate(entry?.date);

    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

export interface PaymentCase {
  documents: PaymentCaseDocument[];
  records: PaymentRecordSet;
  terms: CreditTermsResolution;
  reconciliation: PaymentReconciliation;
}

/** Reads the records, resolves the credit terms, and reconciles payments. No model cost. */
export async function preparePaymentCaseAsync(
  ctx: DocumentAccess & { upstreamFindings?: readonly Finding[] },
  options: PaymentReconcileOptions = {},
): Promise<PaymentCase> {
  const documents = await loadPaymentCaseDocumentsAsync(ctx);
  const records = readPaymentRecords(documents);
  const upstream = ctx.upstreamFindings ?? [];
  const terms = resolveCreditTerms(documents, upstream);
  const asOfDate = options.asOfDate ?? upstreamAsOfDate(upstream);
  const reconciliation = reconcilePayments(records, terms, {
    ...options,
    ...(asOfDate ? { asOfDate } : {}),
  });

  return { documents, records, terms, reconciliation };
}

export interface PaymentReviewPage {
  documentId: string;
  documentName: string;
  page: number;
  confidence: number;
  method: string;
}

/** OCR or handwritten pages below the confidence threshold that a person should check. */
export function paymentPagesToVerify(
  documents: readonly PaymentCaseDocument[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): PaymentReviewPage[] {
  return documents.flatMap(({ metadata, extraction }) => {
    if (!extraction) {
      return [];
    }

    const flagged = new Set(pagesNeedingReview(extraction, threshold));

    return extraction.pages
      .filter((page) => flagged.has(page.index))
      .map((page) => ({
        documentId: metadata.id,
        documentName: metadata.name,
        page: page.index,
        confidence: page.confidence,
        method: page.method,
      }));
  });
}

export interface PreparedHooks<P, I, O> {
  /** Deterministic pre-step with no model cost. */
  prepareAsync(ctx: TaskExecutionContext): Promise<P>;
  buildInput(ctx: TaskExecutionContext, prepared: P): I;
  toTaskOutput(
    result: AgentResult<O>,
    ctx: TaskExecutionContext,
    prepared: P,
  ): TaskOutput | Promise<TaskOutput>;
}

/** Runs a deterministic pre-step, then the agent resolved for this execution. */
export function createPreparedHandler<P, I, O>(
  role: AgentRole,
  resolveAgent: (ctx: TaskExecutionContext) => Agent<I, O>,
  hooks: PreparedHooks<P, I, O>,
): TaskHandler {
  return {
    role,
    async executeAsync(ctx) {
      const prepared = await hooks.prepareAsync(ctx);

      return createAgentTaskHandler(resolveAgent(ctx), {
        prepareInputAsync: async () => hooks.buildInput(ctx, prepared),
        toTaskOutput: (result) => hooks.toTaskOutput(result, ctx, prepared),
      }).executeAsync(ctx);
    },
  };
}

/** The pinned agent, else the one registered for the role, else the use-case default. */
export function resolveAgentFor<A>(
  ctx: TaskExecutionContext,
  role: AgentRole,
  pinned: A | undefined,
  createDefault: () => A,
): A {
  return pinned ?? (ctx.agents.get(role) as A | undefined) ?? createDefault();
}

/** Drops table slices of the invoice and payment records; their rows reach the model as context. */
export function withoutRecordTables<
  T extends { documents: Array<{ kind: string; documentId: string }> },
>(input: T, recordDocumentIds: ReadonlySet<string>): T {
  return {
    ...input,
    documents: input.documents.filter(
      (slice) => !(slice.kind === "table" && recordDocumentIds.has(slice.documentId)),
    ),
  };
}
