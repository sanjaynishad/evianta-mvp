import type { AnyAgent } from "../../agent.js";
import type { TaskHandlerRegistry } from "../../handlers.js";
import type { DeterministicCheckOptions } from "../../verification.js";
import {
  createCaseAnalysisAgent,
  createCaseAnalysisTaskHandler,
  type CaseAnalysisAgent,
} from "./caseAnalysis.js";
import type { TaxReconcileOptions } from "./reconcile.js";
import {
  createReconciliationAgent,
  createReconciliationTaskHandler,
  type ReconciliationAgent,
} from "./reconciliationTask.js";
import {
  createTaxResearchAgent,
  createTaxResearchTaskHandler,
  type TaxResearchAgent,
} from "./research.js";
import {
  createResponsePreparationAgent,
  createResponsePreparationTaskHandler,
  type ResponsePreparationAgent,
} from "./response.js";
import { createTaxNoticeReviewTaskHandler } from "./review.js";

export {
  CASE_ANALYSIS_SYSTEM_PROMPT,
  caseAnalysisOutputSchema,
  createCaseAnalysisAgent,
  createCaseAnalysisTaskHandler,
  noticeAnalysisSchema,
  type CaseAnalysisAgent,
  type CaseAnalysisHandlerOptions,
  type CaseAnalysisOutput,
  type NoticeAnalysis,
} from "./caseAnalysis.js";
export {
  reconciliationLineFigureKey,
  TAX_DATE_KEYS,
  TAX_FIGURE_KEYS,
  TAX_NOTICE_GUARDRAIL,
  taxNoticePackSpec,
} from "./constants.js";
export { pagesToVerify, reconcileCaseAsync, type CaseRecords, type ReviewPage } from "./context.js";
export {
  DEFAULT_RECONCILIATION_TOLERANCE,
  reconcileTaxRecords,
  type ReconciliationLine,
  type ReconciliationStatus,
  type StatementDisagreement,
  type StatementOverlap,
  type TaxReconciliation,
  type TaxReconcileOptions,
} from "./reconcile.js";
export {
  createReconciliationAgent,
  createReconciliationTaskHandler,
  RECONCILIATION_SYSTEM_PROMPT,
  reconciliationOutputSchema,
  type ReconciliationAgent,
  type ReconciliationHandlerOptions,
  type ReconciliationOutput,
} from "./reconciliationTask.js";
export {
  classifyTaxRecordSource,
  mapTaxColumns,
  readTaxRecords,
  TAX_RECORD_SOURCES,
  taxCreditStatementOf,
  type TaxCreditStatement,
  type TaxRecordDocument,
  type TaxRecordRow,
  type TaxRecordSet,
  type TaxRecordSource,
  type TaxRecordTable,
} from "./records.js";
export { reconciliationTableMarkdown } from "./render.js";
export {
  citationsForProvision,
  createTaxResearchAgent,
  createTaxResearchTaskHandler,
  TAX_RESEARCH_SYSTEM_PROMPT,
  taxResearchOutputSchema,
  type Provision,
  type TaxResearchAgent,
  type TaxResearchHandlerOptions,
  type TaxResearchOutput,
} from "./research.js";
export {
  createResponsePreparationAgent,
  createResponsePreparationTaskHandler,
  findFilingClaims,
  OPEN_QUESTIONS_SECTION_TITLE,
  RESPONSE_DRAFT_SECTION_TITLE,
  RESPONSE_PREPARATION_SYSTEM_PROMPT,
  responsePreparationOutputSchema,
  type ResponsePreparationAgent,
  type ResponsePreparationHandlerOptions,
  type ResponsePreparationOutput,
} from "./response.js";
export {
  createTaxNoticeReviewTaskHandler,
  draftFiguresCheck,
  expectedReconciliationFigures,
  quotedAmounts,
  reconciliationDataCheck,
  reconciliationRecomputeCheck,
  type TaxNoticeReviewOptions,
} from "./review.js";

export interface TaxNoticeHandlerOptions {
  reconciliation?: TaxReconcileOptions;
  review?: DeterministicCheckOptions;
  agents?: {
    caseAnalysis?: CaseAnalysisAgent;
    reconciliation?: ReconciliationAgent;
    taxResearch?: TaxResearchAgent;
    responsePreparation?: ResponsePreparationAgent;
  };
}

/** Tax-notice specialist agents, registered as the defaults for their roles. */
export function createTaxNoticeAgents(): AnyAgent[] {
  return [
    createCaseAnalysisAgent(),
    createReconciliationAgent(),
    createTaxResearchAgent(),
    createResponsePreparationAgent(),
  ];
}

/**
 * Registers the tax-notice specialists and wraps the registered independent-review handler so
 * tax-notice cases get the reconciliation and draft-figure checks while other use cases keep it.
 */
export function registerTaxNoticeHandlers(
  registry: TaskHandlerRegistry,
  options: TaxNoticeHandlerOptions = {},
): TaskHandlerRegistry {
  const { agents = {} } = options;

  return registry
    .register(createCaseAnalysisTaskHandler({ agent: agents.caseAnalysis }))
    .register(
      createReconciliationTaskHandler({ ...options.reconciliation, agent: agents.reconciliation }),
    )
    .register(createTaxResearchTaskHandler({ agent: agents.taxResearch }))
    .register(
      createResponsePreparationTaskHandler({
        ...options.reconciliation,
        agent: agents.responsePreparation,
      }),
    )
    .register(
      createTaxNoticeReviewTaskHandler({
        ...options.review,
        fallback: registry.get("independent-review"),
      }),
    );
}
