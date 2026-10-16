import type {
  AgentRole,
  CaseStatus,
  DeliverableFormat,
  DocumentStatus,
  ExtractionMethod,
  FindingSeverity,
  SectionReviewStatus,
  TaskStatus,
  UseCase,
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

export const extractionMethodLabels: Record<ExtractionMethod, string> = {
  parse: "Parsed directly, no model cost",
  "pdf-text": "PDF text layer, no model cost",
  ocr: "Read with OCR",
  handwriting: "Handwriting read by a model",
  mixed: "Mixed reading methods",
};
