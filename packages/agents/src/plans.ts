import type { AgentRole, DeliverableFormat, UseCase } from "@evianta/core";

export interface ReferencePlanTask {
  assignedRole: AgentRole;
  title: string;
  dependsOn: AgentRole[];
}

export interface ReferencePlan {
  useCase: UseCase;
  deliverable: { title: string; format: DeliverableFormat };
  tasks: readonly ReferencePlanTask[];
}

export const REFERENCE_PLANS: Readonly<Record<UseCase, ReferencePlan>> = {
  "data-analysis": {
    useCase: "data-analysis",
    deliverable: { title: "Analysis report", format: "report" },
    tasks: [
      {
        assignedRole: "business-data-analyst",
        title: "Analyze the dataset and report metrics, trends, and anomalies",
        dependsOn: [],
      },
    ],
  },
  "tax-notice": {
    useCase: "tax-notice",
    deliverable: { title: "Notice response pack", format: "document" },
    tasks: [
      {
        assignedRole: "case-analysis",
        title: "Analyze the notice: issues, dates, demanded figures, and requested information",
        dependsOn: [],
      },
      {
        assignedRole: "reconciliation",
        title: "Reconcile return figures with ledgers and tax-credit records",
        dependsOn: ["case-analysis"],
      },
      {
        assignedRole: "tax-research",
        title: "Research applicable provisions and references",
        dependsOn: ["case-analysis"],
      },
      {
        assignedRole: "response-preparation",
        title: "Draft the response with supporting calculations and schedules",
        dependsOn: ["reconciliation", "tax-research"],
      },
      {
        assignedRole: "independent-review",
        title: "Independently review the response pack",
        dependsOn: ["response-preparation"],
      },
    ],
  },
  "msme-payment": {
    useCase: "msme-payment",
    deliverable: { title: "Payment dispute case pack", format: "document" },
    tasks: [
      {
        assignedRole: "document-analysis",
        title: "Organize the documents and extract key fields",
        dependsOn: [],
      },
      {
        assignedRole: "payment-reconciliation",
        title: "Reconcile invoices with payments and compute the outstanding amount",
        dependsOn: ["document-analysis"],
      },
      {
        assignedRole: "evidence-analysis",
        title: "Build the chronology and identify gaps, inconsistencies, and disputed items",
        dependsOn: ["document-analysis", "payment-reconciliation"],
      },
      {
        assignedRole: "legal-research",
        title: "Research contractual and statutory routes",
        dependsOn: ["evidence-analysis"],
      },
      {
        assignedRole: "case-preparation",
        title: "Assemble the case pack and a proposed follow-up or escalation draft",
        dependsOn: ["payment-reconciliation", "evidence-analysis", "legal-research"],
      },
      {
        assignedRole: "independent-review",
        title: "Independently review the case pack",
        dependsOn: ["case-preparation"],
      },
    ],
  },
};

export function referencePlanFor(useCase: UseCase): ReferencePlan {
  return REFERENCE_PLANS[useCase];
}
