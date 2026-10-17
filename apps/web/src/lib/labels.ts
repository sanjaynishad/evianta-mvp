import {
  isDocumentErrorCode,
  type AgentRole,
  type CaseStatus,
  type DeliverableFormat,
  type DocumentErrorCode,
  type DocumentStatus,
  type ExtractionMethod,
  type FindingSeverity,
  type ModelTier,
  type SectionReviewStatus,
  type TaskStatus,
  type UseCase,
} from "@evianta/core";
import type { WorkStatus } from "@/components/patterns/status-badge";

export const agentRoleLabels: Record<AgentRole, string> = {
  coordinator: "Coordinator",
  "business-data-analyst": "Business data analyst",
  "case-analysis": "Case analysis",
  reconciliation: "Reconciliation",
  "tax-research": "Tax research",
  "response-preparation": "Response drafting",
  "document-analysis": "Document analysis",
  "payment-reconciliation": "Payment reconciliation",
  "evidence-analysis": "Evidence analysis",
  "legal-research": "Legal research",
  "case-preparation": "Case preparation",
  "independent-review": "Independent review",
};

export const useCaseLabels: Record<UseCase, string> = {
  "data-analysis": "Business data analysis",
  "tax-notice": "Income-tax notice response",
  "msme-payment": "MSME delayed-payment dispute",
};

export const caseStatusToWorkStatus: Record<CaseStatus, WorkStatus> = {
  draft: "draft",
  planning: "planning",
  "in-progress": "in-progress",
  review: "review",
  completed: "completed",
  failed: "failed",
};

export const taskStatusToWorkStatus: Record<TaskStatus, WorkStatus> = {
  pending: "pending",
  "in-progress": "in-progress",
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
};

export const deliverableFormatLabels: Record<DeliverableFormat, string> = {
  document: "Document",
  report: "Report",
  spreadsheet: "Spreadsheet",
  dashboard: "Dashboard",
};

export const sectionReviewLabels: Record<SectionReviewStatus, string> = {
  pending: "Awaiting review",
  approved: "Approved",
  "needs-changes": "Needs changes",
};

export const findingSeverityLabels: Record<FindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Note",
};

export const documentStatusLabels: Record<DocumentStatus, string> = {
  pending: "Queued",
  processing: "Reading",
  ready: "Ready",
  partial: "Partly read",
  failed: "Failed",
};

export const documentErrorMessages: Record<DocumentErrorCode, string> = {
  "unsupported-type":
    "This file type cannot be read. Upload CSV, TSV, Excel, JSON, text, Markdown, PDF, PNG, JPEG, or WebP files.",
  "ocr-unavailable":
    "Text recognition is unavailable right now. The file is read again when the case runs.",
  "ocr-failed":
    "Text recognition could not read this file. It is tried again when the case runs; a clearer scan helps.",
  "ocr-partial": "Some pages could not be read. Check the pages flagged for review.",
  "extraction-failed":
    "The contents of this file could not be extracted. Check that it opens, then upload it again.",
  "read-failed": "The stored file could not be read. It is tried again when the case runs.",
};

// A friendly message for known codes, otherwise the server's client-safe message.
export function describeDocumentError(document: {
  error?: string;
  errorCode?: string;
}): string | undefined {
  if (isDocumentErrorCode(document.errorCode)) {
    return documentErrorMessages[document.errorCode];
  }

  return document.error;
}

export const extractionMethodLabels: Record<ExtractionMethod, string> = {
  parse: "Parsed directly, no model cost",
  "pdf-text": "PDF text layer, no model cost",
  ocr: "Read with OCR",
  handwriting: "Handwriting read by a model",
  mixed: "Mixed reading methods",
};

export const modelTierLabels: Record<ModelTier, string> = {
  cheap: "Cheap tier model",
  mid: "Mid tier model",
  high: "High tier model",
};
