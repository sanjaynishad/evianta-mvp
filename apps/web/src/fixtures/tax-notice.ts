import type { CaseStateInput } from "@evianta/core";

const caseId = "sample-tax-notice";
const createdAt = "2026-09-30T05:10:00.000Z";
const finishedAt = "2026-09-30T05:19:30.000Z";

const notice = { id: "b-doc-notice", name: "intimation_143_1a_AY2025-26.pdf" };
const form26as = { id: "b-doc-26as", name: "form26AS_AY2025-26_scan.pdf" };
const ledger = { id: "b-doc-ledger", name: "ledger_professional_receipts_FY2024-25.xlsx" };
const note = { id: "b-doc-note", name: "client_note_tds_certificates.jpg" };

export const taxNoticeCaseState: CaseStateInput = {
  case: {
    id: caseId,
    title: "ITR intimation 143(1)(a) - Sharma Textiles",
    description:
      "Respond to the intimation proposing an adjustment for a TDS mismatch between Form 26AS and the return for AY 2025-26.",
    useCase: "tax-notice",
    status: "review",
    isSample: true,
    usage: {
      inputTokens: 41250,
      outputTokens: 9830,
      costEstimate: 0.0688,
      runCount: 1,
      lastRunAt: finishedAt,
    },
    createdAt,
    updatedAt: finishedAt,
  },
  documents: [
    {
      id: notice.id,
      caseId,
      name: notice.name,
      mimeType: "application/pdf",
      size: 184220,
      gcsPath: `cases/${caseId}/documents/${notice.id}`,
      uploadedAt: "2026-09-30T05:11:00.000Z",
      processing: { status: "ready", method: "pdf-text", confidence: 0.98 },
    },
    {
      id: form26as.id,
      caseId,
      name: form26as.name,
      mimeType: "application/pdf",
      size: 902311,
      gcsPath: `cases/${caseId}/documents/${form26as.id}`,
      uploadedAt: "2026-09-30T05:11:20.000Z",
      processing: {
        status: "ready",
        method: "ocr",
        confidence: 0.86,
        warnings: ["Page 3 is slightly skewed; amounts were cross-checked against totals."],
      },
    },
    {
      id: ledger.id,
      caseId,
      name: ledger.name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 61204,
      gcsPath: `cases/${caseId}/documents/${ledger.id}`,
      uploadedAt: "2026-09-30T05:11:40.000Z",
      processing: { status: "ready", method: "parse", confidence: 1 },
    },
    {
      id: note.id,
      caseId,
      name: note.name,
      mimeType: "image/jpeg",
      size: 1320442,
      gcsPath: `cases/${caseId}/documents/${note.id}`,
      uploadedAt: "2026-09-30T05:12:05.000Z",
      processing: {
        status: "ready",
        method: "handwriting",
        confidence: 0.58,
        handwritingDetected: true,
        warnings: ["Handwritten amounts should be checked against the original."],
      },
    },
  ],
  tasks: [
    {
      id: "b-task-analysis",
      caseId,
      title: "Read the notice and list the issues",
      assignedRole: "case-analysis",
      status: "completed",
      attempts: 1,
      tokenUsage: { input: 6100, output: 1210, total: 7310 },
      costEstimate: 0.0042,
    },
    {
      id: "b-task-reconcile",
      caseId,
      title: "Reconcile TDS in Form 26AS with the ledger",
      assignedRole: "reconciliation",
      status: "completed",
      dependsOn: ["b-task-analysis"],
      attempts: 1,
      tokenUsage: { input: 9800, output: 2040, total: 11840 },
      costEstimate: 0.0094,
    },
    {
      id: "b-task-research",
      caseId,
      title: "Find the provisions that apply",
      assignedRole: "tax-research",
      status: "completed",
      dependsOn: ["b-task-analysis"],
      attempts: 1,
      tokenUsage: { input: 7400, output: 1630, total: 9030 },
      costEstimate: 0.0193,
    },
    {
      id: "b-task-draft",
      caseId,
      title: "Draft the response",
      assignedRole: "response-preparation",
      status: "completed",
      dependsOn: ["b-task-reconcile", "b-task-research"],
      attempts: 1,
      tokenUsage: { input: 10150, output: 3520, total: 13670 },
      costEstimate: 0.0128,
    },
    {
      id: "b-task-review",
      caseId,
      title: "Independently review the response pack",
      assignedRole: "independent-review",
      status: "completed",
      dependsOn: ["b-task-draft"],
      attempts: 1,
      tokenUsage: { input: 7800, output: 1430, total: 9230 },
      costEstimate: 0.0231,
    },
  ],
  findings: [
    {
      id: "b-finding-issue",
      taskId: "b-task-analysis",
      summary: "The intimation proposes to disallow TDS credit of 12,400",
      detail:
        "The CPC allowed TDS of 1,86,600 against 1,99,000 claimed. A response is due within 30 days of the intimation date, 18 Sep 2026.",
      severity: "high",
      confidence: "high",
      evidence: [
        {
          id: "b-ev-notice-para",
          sourceRef: notice.name,
          description: "Adjustment table in the intimation",
          excerpt: "TDS claimed 1,99,000; TDS as per 26AS 1,86,600; Difference 12,400",
          documentId: notice.id,
          location: {
            page: 2,
            bbox: { x: 0.08, y: 0.42, width: 0.84, height: 0.12 },
            textQuote: "Difference 12,400",
          },
          confidence: "high",
        },
      ],
    },
    {
      id: "b-finding-mismatch",
      taskId: "b-task-reconcile",
      summary: "The 12,400 gap is TDS by one deductor filed under the wrong PAN",
      detail:
        "Ledger receipts from Mehta Exports carry TDS of 12,400 that does not appear in Form 26AS. The deductor's TDS certificate shows a PAN differing by one character.",
      severity: "high",
      confidence: "medium",
      evidence: [
        {
          id: "b-ev-ledger-rows",
          sourceRef: ledger.name,
          description: "Receipts from Mehta Exports with TDS deducted",
          documentId: ledger.id,
          location: { sheet: "Receipts", rowRange: { start: 182, end: 190 } },
          confidence: "high",
        },
        {
          id: "b-ev-26as-page",
          sourceRef: form26as.name,
          description: "Part A of Form 26AS, deductors list",
          documentId: form26as.id,
          location: {
            page: 3,
            bbox: { x: 0.06, y: 0.3, width: 0.88, height: 0.36 },
            textQuote: "Total TDS 1,86,600",
          },
          confidence: "medium",
        },
        {
          id: "b-ev-client-note",
          sourceRef: note.name,
          description: "Client's handwritten note about the TDS certificate",
          excerpt: "Mehta Exports TDS cert PAN AAKPS1234Q (check)",
          documentId: note.id,
          location: { bbox: { x: 0.1, y: 0.2, width: 0.7, height: 0.25 } },
          confidence: "low",
        },
      ],
      assumptions: ["Form 16A from Mehta Exports reflects the deduction actually made."],
      openQuestions: [
        {
          id: "b-q-pan-correction",
          text: "Has Mehta Exports been asked to file a correction statement with the right PAN?",
          severity: "high",
        },
      ],
    },
    {
      id: "b-finding-provision",
      taskId: "b-task-research",
      summary: "Credit can be claimed once the deductor corrects the TDS statement",
      detail:
        "Section 199 read with Rule 37BA allows credit for tax deducted and paid. The response should request rectification under section 154 after the deductor's correction. Verify against current law before filing.",
      severity: "medium",
      confidence: "medium",
      evidence: [
        {
          id: "b-ev-research",
          sourceRef: "https://incometaxindia.gov.in/",
          description: "Section 199 and Rule 37BA, Income-tax Act and Rules",
          confidence: "medium",
        },
      ],
      openQuestions: [
        {
          id: "b-q-verify-law",
          text: "Verify the cited provisions against the law in force for AY 2025-26.",
          severity: "medium",
        },
      ],
    },
  ],
  deliverables: [
    {
      id: "b-deliverable-pack",
      caseId,
      title: "Response pack for the 143(1)(a) intimation",
      format: "document",
      sections: [
        {
          id: "b-section-issues",
          title: "Issues raised",
          kind: "text",
          content:
            "The intimation proposes to disallow TDS credit of 12,400, the difference between TDS claimed in the return and TDS shown in Form 26AS.",
          producedByRole: "case-analysis",
          modelTier: "cheap",
          findingIds: ["b-finding-issue"],
          evidenceIds: ["b-ev-notice-para"],
          reviewStatus: "approved",
        },
        {
          id: "b-section-reconciliation",
          title: "TDS reconciliation",
          kind: "table",
          content:
            "Deductor            Ledger TDS   Form 26AS TDS   Difference\nMehta Exports           12,400               0       12,400\nOther deductors       1,86,600        1,86,600            0\nTotal                 1,99,000        1,86,600       12,400",
          producedByRole: "reconciliation",
          modelTier: "mid",
          findingIds: ["b-finding-mismatch"],
          evidenceIds: ["b-ev-ledger-rows", "b-ev-26as-page"],
        },
        {
          id: "b-section-draft",
          title: "Draft response",
          kind: "text",
          content:
            "With reference to the intimation under section 143(1)(a) for AY 2025-26, the difference of 12,400 arises because Mehta Exports reported the deduction under an incorrect PAN.\n\nThe assessee has requested the deductor to file a correction statement. A copy of Form 16A and the ledger extract are enclosed. We request that the credit be allowed on rectification under section 154 once the corrected statement is processed.",
          producedByRole: "response-preparation",
          modelTier: "mid",
          findingIds: ["b-finding-mismatch", "b-finding-provision"],
          evidenceIds: ["b-ev-ledger-rows", "b-ev-client-note", "b-ev-research"],
        },
      ],
    },
  ],
  latestRun: {
    runId: "b-run-1",
    status: "completed",
    startedAt: "2026-09-30T05:13:00.000Z",
    finishedAt,
  },
};
