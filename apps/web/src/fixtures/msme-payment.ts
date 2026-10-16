import type { CaseStateInput } from "@evianta/core";
import { extractionSummary } from "./documents";

const caseId = "sample-msme-payment";
const createdAt = "2026-10-02T06:00:00.000Z";
const finishedAt = "2026-10-02T06:11:15.000Z";

const invoices = { id: "c-doc-invoices", name: "invoices_KF-2025-101_to_118.pdf" };
const statement = { id: "c-doc-statement", name: "statement_of_account_apex_motors.xlsx" };
const udyam = { id: "c-doc-udyam", name: "udyam_registration_certificate.pdf" };
const reminders = { id: "c-doc-reminders", name: "payment_reminder_emails.pdf" };

export const msmePaymentCaseState: CaseStateInput = {
  case: {
    id: caseId,
    title: "Delayed payment claim - Kaveri Fabricators vs Apex Motors",
    description:
      "Prepare a delayed-payment claim for invoices unpaid beyond 45 days, with interest under the MSMED Act and supporting evidence.",
    useCase: "msme-payment",
    status: "completed",
    isSample: true,
    usage: {
      inputTokens: 52300,
      outputTokens: 11840,
      costEstimate: 0.0815,
      runCount: 1,
      lastRunAt: finishedAt,
    },
    createdAt,
    updatedAt: finishedAt,
  },
  documents: [
    {
      id: invoices.id,
      caseId,
      name: invoices.name,
      mimeType: "application/pdf",
      size: 2210400,
      uploadedAt: "2026-10-02T06:01:00.000Z",
      status: "ready",
      extraction: extractionSummary("mixed", 0.91, { pageCount: 4 }),
    },
    {
      id: statement.id,
      caseId,
      name: statement.name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 40980,
      uploadedAt: "2026-10-02T06:01:20.000Z",
      status: "ready",
      extraction: extractionSummary("parse", 1),
    },
    {
      id: udyam.id,
      caseId,
      name: udyam.name,
      mimeType: "application/pdf",
      size: 120330,
      uploadedAt: "2026-10-02T06:01:40.000Z",
      status: "ready",
      extraction: extractionSummary("pdf-text", 0.99),
    },
    {
      id: reminders.id,
      caseId,
      name: reminders.name,
      mimeType: "application/pdf",
      size: 310220,
      uploadedAt: "2026-10-02T06:02:00.000Z",
      status: "ready",
      extraction: extractionSummary("pdf-text", 0.97, { pageCount: 2 }),
    },
  ],
  tasks: [
    {
      id: "c-task-documents",
      caseId,
      title: "Index the invoices and correspondence",
      assignedRole: "document-analysis",
      status: "completed",
      attempts: 1,
      tokenUsage: { input: 11200, output: 2210, total: 13410 },
      costEstimate: 0.0071,
    },
    {
      id: "c-task-payments",
      caseId,
      title: "Reconcile invoices with payments received",
      assignedRole: "payment-reconciliation",
      status: "completed",
      dependsOn: ["c-task-documents"],
      attempts: 1,
      tokenUsage: { input: 9400, output: 1980, total: 11380 },
      costEstimate: 0.0089,
    },
    {
      id: "c-task-evidence",
      caseId,
      title: "Check MSME status and delivery evidence",
      assignedRole: "evidence-analysis",
      status: "completed",
      dependsOn: ["c-task-documents"],
      attempts: 1,
      tokenUsage: { input: 6800, output: 1240, total: 8040 },
      costEstimate: 0.0048,
    },
    {
      id: "c-task-legal",
      caseId,
      title: "Research the MSMED Act provisions",
      assignedRole: "legal-research",
      status: "completed",
      dependsOn: ["c-task-documents"],
      attempts: 1,
      tokenUsage: { input: 7100, output: 1690, total: 8790 },
      costEstimate: 0.0187,
    },
    {
      id: "c-task-prepare",
      caseId,
      title: "Prepare the case pack and draft claim",
      assignedRole: "case-preparation",
      status: "completed",
      dependsOn: ["c-task-payments", "c-task-evidence", "c-task-legal"],
      attempts: 1,
      tokenUsage: { input: 10600, output: 3480, total: 14080 },
      costEstimate: 0.0182,
    },
    {
      id: "c-task-review",
      caseId,
      title: "Independently review the case pack",
      assignedRole: "independent-review",
      status: "completed",
      dependsOn: ["c-task-prepare"],
      attempts: 1,
      tokenUsage: { input: 7200, output: 1240, total: 8440 },
      costEstimate: 0.0238,
    },
  ],
  findings: [
    {
      id: "c-finding-overdue",
      taskId: "c-task-payments",
      summary: "Four invoices totalling 8,42,000 are unpaid beyond 45 days",
      detail:
        "Invoices KF-2025-104, 107, 111, and 115 remain unpaid between 63 and 148 days after acceptance. Part payments against other invoices were applied oldest first.",
      severity: "high",
      confidence: "high",
      evidence: [
        {
          id: "c-ev-statement-rows",
          sourceRef: statement.name,
          description: "Open invoices in the statement of account",
          documentId: statement.id,
          location: { sheet: "SOA", rowRange: { start: 14, end: 29 } },
          confidence: "high",
        },
        {
          id: "c-ev-invoice-104",
          sourceRef: invoices.name,
          description: "Invoice KF-2025-104 with acceptance stamp",
          documentId: invoices.id,
          location: {
            page: 4,
            bbox: { x: 0.55, y: 0.78, width: 0.35, height: 0.12 },
            textQuote: "Received and accepted",
          },
          confidence: "medium",
        },
      ],
      assumptions: ["Acceptance is taken as the stamped date of receipt on each invoice."],
    },
    {
      id: "c-finding-interest",
      taskId: "c-task-prepare",
      summary: "Interest under section 16 comes to 61,870 to date",
      detail:
        "Compound interest with monthly rests at three times the RBI bank rate, computed from the 46th day after acceptance until 2 Oct 2026.",
      severity: "medium",
      confidence: "high",
      evidence: [
        {
          id: "c-ev-statement-rows-interest",
          sourceRef: statement.name,
          description: "Invoice amounts and acceptance dates used for the computation",
          documentId: statement.id,
          location: { sheet: "SOA", cellRange: "B14:F29" },
          confidence: "high",
        },
      ],
      openQuestions: [
        {
          id: "c-q-bank-rate",
          text: "Confirm the RBI bank rate applicable for each period before filing.",
          severity: "medium",
        },
      ],
    },
    {
      id: "c-finding-udyam",
      taskId: "c-task-evidence",
      summary: "Udyam registration predates every unpaid invoice",
      detail: "Registered as a micro enterprise on 14 Mar 2023, before the first unpaid invoice.",
      severity: "info",
      confidence: "high",
      evidence: [
        {
          id: "c-ev-udyam",
          sourceRef: udyam.name,
          description: "Udyam registration number and date of registration",
          documentId: udyam.id,
          location: { page: 1, textQuote: "Date of Udyam Registration 14/03/2023" },
          confidence: "high",
        },
      ],
    },
    {
      id: "c-finding-reminders",
      taskId: "c-task-documents",
      summary: "Three written reminders were sent before the claim",
      detail: "Reminders on 12 Jun, 18 Jul, and 22 Aug 2026; the buyer acknowledged the dues once.",
      severity: "low",
      confidence: "high",
      evidence: [
        {
          id: "c-ev-reminders",
          sourceRef: reminders.name,
          description: "Reminder emails and the buyer's acknowledgement",
          documentId: reminders.id,
          location: { page: 2, textQuote: "We acknowledge the outstanding amount" },
          confidence: "high",
        },
      ],
      openQuestions: [
        {
          id: "c-q-acknowledgement",
          text: "Is there a signed acknowledgement in addition to the email?",
          severity: "low",
        },
      ],
    },
  ],
  deliverables: [
    {
      id: "c-deliverable-pack",
      caseId,
      title: "Case pack for the MSME Facilitation Council",
      format: "document",
      sections: [
        {
          id: "c-section-summary",
          title: "Claim summary",
          kind: "text",
          content:
            "Kaveri Fabricators, a registered micro enterprise, claims 8,42,000 in principal and 61,870 in interest to date from Apex Motors for four invoices unpaid beyond 45 days.",
          producedByRole: "case-preparation",
          modelTier: "mid",
          findingIds: ["c-finding-overdue", "c-finding-interest", "c-finding-udyam"],
          evidenceIds: ["c-ev-statement-rows", "c-ev-udyam"],
        },
        {
          id: "c-section-chronology",
          title: "Chronology",
          kind: "timeline",
          content:
            "14 Mar 2023  Udyam registration as a micro enterprise\n05 May 2026  Invoice KF-2025-104 accepted\n12 Jun 2026  First payment reminder\n18 Jul 2026  Second reminder\n22 Aug 2026  Third reminder; buyer acknowledges dues by email\n02 Oct 2026  Claim prepared",
          producedByRole: "case-preparation",
          modelTier: "mid",
          findingIds: ["c-finding-reminders"],
          evidenceIds: ["c-ev-udyam", "c-ev-invoice-104", "c-ev-reminders"],
        },
        {
          id: "c-section-interest",
          title: "Interest computation",
          kind: "table",
          content:
            "Invoice        Amount   Days overdue   Interest\nKF-2025-104  2,40,000            148     28,410\nKF-2025-107  1,95,000            112     15,920\nKF-2025-111  2,12,000             84     11,540\nKF-2025-115  1,95,000             63      6,000\nTotal        8,42,000                    61,870",
          producedByRole: "payment-reconciliation",
          modelTier: "mid",
          findingIds: ["c-finding-interest"],
          evidenceIds: ["c-ev-statement-rows-interest"],
        },
      ],
    },
  ],
  run: { active: false, lastEventSeq: 0, lastRunId: "c-run-1", lastEventType: "run-completed" },
};
