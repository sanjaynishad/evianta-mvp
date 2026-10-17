import type { AnyAgent } from "../../agent.js";
import type { TaskHandler, TaskHandlerRegistry } from "../../handlers.js";
import type { DeterministicCheckOptions } from "../../verification.js";
import {
  createCasePreparationAgent,
  createCasePreparationTaskHandler,
  type CasePreparationAgent,
} from "./casePreparation.js";
import {
  createDocumentAnalysisAgent,
  createDocumentAnalysisTaskHandler,
  type DocumentAnalysisAgent,
} from "./documentAnalysis.js";
import {
  createEvidenceAnalysisAgent,
  createEvidenceAnalysisTaskHandler,
  type EvidenceAnalysisAgent,
} from "./evidenceAnalysis.js";
import {
  createLegalResearchAgent,
  createLegalResearchTaskHandler,
  type LegalResearchAgent,
} from "./legalResearch.js";
import {
  createPaymentReconciliationAgent,
  createPaymentReconciliationTaskHandler,
  type PaymentReconciliationAgent,
} from "./paymentReconciliationTask.js";
import type { PaymentReconcileOptions } from "./reconcile.js";
import { createMsmePaymentReviewTaskHandler } from "./review.js";

export {
  CASE_PACK_QUESTIONS_SECTION_TITLE,
  CASE_PREPARATION_SYSTEM_PROMPT,
  casePreparationOutputSchema,
  CHRONOLOGY_SECTION_TITLE,
  createCasePreparationAgent,
  createCasePreparationTaskHandler,
  ESCALATION_DRAFT_SECTION_TITLE,
  findEscalationClaims,
  FOLLOW_UP_DRAFT_SECTION_TITLE,
  followUpDraftSchema,
  PAYMENT_SUMMARY_SECTION_TITLE,
  SUPPORTING_DOCUMENTS_SECTION_TITLE,
  type CasePreparationAgent,
  type CasePreparationHandlerOptions,
  type CasePreparationOutput,
  type FollowUpDraft,
} from "./casePreparation.js";
export {
  buildChronology,
  chronologyTimelineText,
  documentEventDateKey,
  documentFactsFromFindings,
  findInconsistencies,
  findMissingDocuments,
  parseDocumentEventKey,
  type ChronologyEvent,
  type ChronologyEventKind,
  type DocumentEventFact,
  type DocumentEventKind,
  type DocumentFacts,
  type EvidenceGap,
  type StatedInvoiceAmount,
} from "./chronology.js";
export {
  invoiceOutstandingFigureKey,
  MSME_DATE_KEYS,
  MSME_FIGURE_KEYS,
  MSME_PAYMENT_GUARDRAIL,
  msmePaymentPackSpec,
  MSMED_MAX_CREDIT_DAYS,
  statedInvoiceAmountFigureKey,
} from "./constants.js";
export {
  paymentPagesToVerify,
  preparePaymentCaseAsync,
  type PaymentCase,
  type PaymentReviewPage,
} from "./context.js";
export {
  createDocumentAnalysisAgent,
  createDocumentAnalysisTaskHandler,
  DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
  documentAnalysisOutputSchema,
  msmeDocumentKindSchema,
  type DocumentAnalysisAgent,
  type DocumentAnalysisHandlerOptions,
  type DocumentAnalysisOutput,
  type MsmeDocumentKind,
} from "./documentAnalysis.js";
export {
  createEvidenceAnalysisAgent,
  createEvidenceAnalysisTaskHandler,
  disputedItemSchema,
  EVIDENCE_ANALYSIS_SYSTEM_PROMPT,
  evidenceAnalysisOutputSchema,
  type DisputedItem,
  type EvidenceAnalysisAgent,
  type EvidenceAnalysisHandlerOptions,
  type EvidenceAnalysisOutput,
} from "./evidenceAnalysis.js";
export {
  citationsForRoute,
  createLegalResearchAgent,
  createLegalResearchTaskHandler,
  LEGAL_RESEARCH_SYSTEM_PROMPT,
  legalResearchOutputSchema,
  legalRouteSchema,
  type LegalResearchAgent,
  type LegalResearchHandlerOptions,
  type LegalResearchOutput,
  type LegalRoute,
} from "./legalResearch.js";
export {
  createPaymentReconciliationAgent,
  createPaymentReconciliationTaskHandler,
  PAYMENT_RECONCILIATION_SYSTEM_PROMPT,
  paymentReconciliationOutputSchema,
  type PaymentReconciliationAgent,
  type PaymentReconciliationHandlerOptions,
  type PaymentReconciliationOutput,
} from "./paymentReconciliationTask.js";
export {
  classifyRecordTable,
  normalizeInvoiceNumber,
  readPaymentRecords,
  resolveInvoiceKey,
  type InvoiceRecord,
  type PaymentCaseDocument,
  type PaymentRecord,
  type PaymentRecordKind,
  type PaymentRecordSet,
  type RepeatedPayment,
} from "./records.js";
export {
  DEFAULT_PAYMENT_TOLERANCE,
  reconcilePayments,
  type AllocationMethod,
  type InvoiceLine,
  type PaymentAllocation,
  type PaymentReconcileOptions,
  type PaymentReconciliation,
  type UnallocatedPayment,
} from "./reconcile.js";
export { paymentReconciliationTableMarkdown } from "./render.js";
export {
  createMsmePaymentReviewTaskHandler,
  expectedPaymentFigures,
  msmePaymentReviewChecks,
  outstandingRecomputeCheck,
  quotedAmountsCheck,
  quotedDatesCheck,
  quotedRupeeAmounts,
  type MsmePaymentReviewCheckInput,
  type MsmePaymentReviewOptions,
} from "./review.js";
export {
  creditTermsInDocuments,
  resolveCreditTerms,
  type CreditTerms,
  type CreditTermsResolution,
} from "./terms.js";

export interface MsmePaymentHandlerOptions {
  reconciliation?: PaymentReconcileOptions;
  review?: DeterministicCheckOptions;
  agents?: {
    documentAnalysis?: DocumentAnalysisAgent;
    paymentReconciliation?: PaymentReconciliationAgent;
    evidenceAnalysis?: EvidenceAnalysisAgent;
    legalResearch?: LegalResearchAgent;
    casePreparation?: CasePreparationAgent;
  };
  /** Reviewer for other use cases; the generic deterministic-first reviewer by default. */
  reviewFallback?: TaskHandler;
}

/** MSME payment specialist agents, registered as the defaults for their roles. */
export function createMsmePaymentAgents(): AnyAgent[] {
  return [
    createDocumentAnalysisAgent(),
    createPaymentReconciliationAgent(),
    createEvidenceAnalysisAgent(),
    createLegalResearchAgent(),
    createCasePreparationAgent(),
  ];
}

/**
 * The five MSME payment specialists plus an independent-review handler that adds the payment
 * recompute and quoted amount and date checks for MSME cases and defers to the fallback otherwise.
 */
export function createMsmePaymentTaskHandlers(
  options: MsmePaymentHandlerOptions = {},
): TaskHandler[] {
  const { agents = {}, reconciliation } = options;

  return [
    createDocumentAnalysisTaskHandler({ agent: agents.documentAnalysis }),
    createPaymentReconciliationTaskHandler({
      ...reconciliation,
      agent: agents.paymentReconciliation,
    }),
    createEvidenceAnalysisTaskHandler({ ...reconciliation, agent: agents.evidenceAnalysis }),
    createLegalResearchTaskHandler({ agent: agents.legalResearch }),
    createCasePreparationTaskHandler({ ...reconciliation, agent: agents.casePreparation }),
    createMsmePaymentReviewTaskHandler({
      ...options.review,
      ...(reconciliation ? { reconciliation } : {}),
      ...(options.reviewFallback ? { fallback: options.reviewFallback } : {}),
    }),
  ];
}

/** Registers the MSME payment handlers, wrapping the registry's current independent-review handler. */
export function registerMsmePaymentHandlers(
  registry: TaskHandlerRegistry,
  options: MsmePaymentHandlerOptions = {},
): TaskHandlerRegistry {
  const fallback = options.reviewFallback ?? registry.get("independent-review");

  for (const handler of createMsmePaymentTaskHandlers({
    ...options,
    ...(fallback ? { reviewFallback: fallback } : {}),
  })) {
    registry.register(handler);
  }

  return registry;
}
