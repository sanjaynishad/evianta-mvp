import { VERIFY_AGAINST_CURRENT_LAW } from "@evianta/ai";
import type { Finding, OpenQuestionSeverity } from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent, type AgentResult } from "../../agent.js";
import {
  SPECIALIST_DEFINITIONS,
  specialistInputSchema,
  type SpecialistInput,
} from "../../agents/specialist.js";
import {
  agentFindingSchema,
  specialistOutputSchema,
  type AgentFindingInput,
  type EvidenceReference,
  type OpenQuestionDraft,
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
  type TaskSectionDraft,
} from "../../handlers.js";
import {
  chronologyTimelineText,
  recordRowEvidence,
  type ChronologyEvent,
  type DocumentEventKind,
} from "./chronology.js";
import {
  formatInrAmount,
  markdownTableOf,
  MSME_FIGURE_KEYS,
  MSME_PAYMENT_GUARDRAIL,
  msmePaymentPackSpec,
} from "./constants.js";
import {
  createPreparedHandler,
  paymentPagesToVerify,
  resolveAgentFor,
  withoutRecordTables,
} from "./context.js";
import {
  chronologyFinding,
  dedupeEvidenceReferences,
  prepareEvidenceAnalysisAsync,
  type EvidenceAnalysisPrepared,
} from "./evidenceAnalysis.js";
import { recordTableKeys } from "./records.js";
import {
  hasPaymentData,
  hasVerifiablePaymentData,
  type PaymentReconcileOptions,
  type PaymentReconciliation,
} from "./reconcile.js";
import { paymentSummaryTableMarkdown, unallocatedPaymentsMarkdown } from "./render.js";

export const PAYMENT_SUMMARY_SECTION_TITLE = "Verified payment summary and outstanding amount";
export const CHRONOLOGY_SECTION_TITLE = "Chronology";
export const SUPPORTING_DOCUMENTS_SECTION_TITLE = "Supporting document references";
export const FOLLOW_UP_DRAFT_SECTION_TITLE = "Proposed follow-up draft";
export const ESCALATION_DRAFT_SECTION_TITLE = "Proposed escalation draft";
export const CASE_PACK_QUESTIONS_SECTION_TITLE =
  "Missing documents, inconsistencies, disputed items, and open questions";
export const MAX_EVIDENCE_PER_DRAFT_PART = 6;

export const followUpDraftSchema = z.object({
  kind: z.enum(["follow-up", "escalation"]).default("follow-up"),
  subject: z.string().min(1),
  salutation: z.string().optional(),
  parts: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        /** Ids of the prior findings this part relies on. */
        findingIds: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  closing: z.string().optional(),
});

export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;

export const casePreparationOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  draft: followUpDraftSchema.optional(),
});

export type CasePreparationOutput = z.infer<typeof casePreparationOutputSchema>;

export type CasePreparationAgent = Agent<SpecialistInput, CasePreparationOutput>;

export const CASE_PREPARATION_SYSTEM_PROMPT = [
  "You prepare the case pack for an MSME supplier's overdue payments, for the business owner or adviser to review, edit, and approve.",
  "Draft a proposed follow-up letter to the buyer in draft (kind follow-up). Propose an escalation draft (kind escalation) only when priorFindings show the buyer has already been reminded and the balance is still unpaid, and even then frame it as an option for the supplier to decide.",
  "Write a subject, an optional salutation, numbered parts (the outstanding position, the invoices and payments it rests on, the disputed or missing items to resolve, and the requested action), and an optional closing. Each part lists the findingIds from priorFindings it relies on.",
  "Quote only amounts and dates that appear in context.computedFigures, context.outstandingPosition, context.chronology, or priorFindings, exactly as given. Never compute new totals, interest, or day counts.",
  "The draft is a proposal. Never state or imply that it has been sent, that a claim or reference has been filed or escalated, or that the buyer is legally liable; where the outcome depends on law or unconfirmed facts, say what must be confirmed.",
  "Put anything the supplier must decide or obtain in openQuestions with a severity.",
].join("\n");

export function createCasePreparationAgent(): CasePreparationAgent {
  const { profile } = SPECIALIST_DEFINITIONS["case-preparation"];

  return defineAgent<SpecialistInput, CasePreparationOutput>({
    role: "case-preparation",
    modelTier: profile.modelTier,
    systemPrompt: CASE_PREPARATION_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: casePreparationOutputSchema,
    grounding: false,
    maxOutputTokens: 6144,
    profile,
  });
}

// Claims that the platform sent, filed, or escalated something. Historical facts such as "reminders
// were sent on" or "we sent reminders" are not claims; sending or submitting this letter, a
// complaint, a claim, or a reference is.
const CLAIM_OBJECT =
  "(?:this|the|a|an|our)\\s+(?:letter|notice|complaint|claim|reference|application|petition|case|draft|escalation)";
const ACTION_CLAIMS: readonly RegExp[] = [
  /\b(claim|reference|complaint|application|case|petition|notice|letter|this\s+(?:draft|letter))\b[^.\n]{0,60}\b(has|have)\s+been\s+(sent|filed|submitted|lodged|registered|escalated|referred)\b/i,
  new RegExp(
    `\\bwe\\s+(?:have\\s+)?(?:sent|submitted|filed|lodged|registered|referred|escalated)\\s+${CLAIM_OBJECT}\\b`,
    "i",
  ),
  /\bwe\s+(?:have\s+)?(?:escalated|lodged)\b/i,
  /\bwe\s+have\s+(?:filed|registered|referred)\b/i,
  /\bhereby\s+(file|submit|refer|escalate)\b/i,
  /\b(has|have)\s+been\s+escalated\b/i,
];

/** Sentences that claim an escalation, filing, or sending happened, which the platform never does. */
export function findEscalationClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) => sentence.length > 0 && ACTION_CLAIMS.some((pattern) => pattern.test(sentence)),
    );
}

function conditionLegalClaimsInText(content: string): { content: string; changed: boolean } {
  let changed = false;
  const abbreviationPattern =
    /(?:\b(?:rs|inr|mr|mrs|ms|dr|no|nos|approx|etc|vs|sec|ss|cl|art|para|pvt|ltd|co)|\b(?:e\.g|i\.e))\.$/i;
  const segments: string[] = [];
  let start = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "." && character !== "!" && character !== "?" && character !== "\n") {
      continue;
    }

    if (
      character === "." &&
      ((/\d/.test(content[index - 1] ?? "") && /\d/.test(content[index + 1] ?? "")) ||
        abbreviationPattern.test(content.slice(start, index + 1).trimEnd()))
    ) {
      continue;
    }

    segments.push(content.slice(start, index + 1));
    start = index + 1;
  }

  if (start < content.length) {
    segments.push(content.slice(start));
  }

  const conditionedContent = segments
    .map((sentence) => {
      const discussesInterest = /\b(?:interest|MSMED|statutory)\b/i.test(sentence);
      const assertsEntitlement =
        /\b(?:entitled|liable|payable|due|must\s+pay|shall\s+pay|will\s+pay|will\s+accrue|accrues|can\s+(?:claim|recover))\b/i.test(
          sentence,
        );

      if (!discussesInterest || !assertsEntitlement) {
        return sentence;
      }

      changed = true;
      const leadingWhitespace = sentence.match(/^\s*/)?.[0] ?? "";

      return `${leadingWhitespace}Any statutory interest remains subject to confirmation of the supplier's eligibility, the relevant dates, and current law. Confirm these points with an adviser before relying on this route.`;
    })
    .join("");

  return { content: conditionedContent, changed };
}

function conditionLegalClaims(draft: FollowUpDraft): { draft: FollowUpDraft; changed: boolean } {
  let changed = false;
  const condition = (content: string) => {
    const result = conditionLegalClaimsInText(content);
    changed ||= result.changed;

    return result.content;
  };

  return {
    draft: {
      ...draft,
      subject: condition(draft.subject),
      ...(draft.salutation ? { salutation: condition(draft.salutation) } : {}),
      parts: draft.parts.map((part) => ({
        ...part,
        title: condition(part.title),
        content: condition(part.content),
      })),
      ...(draft.closing ? { closing: condition(draft.closing) } : {}),
    },
    changed,
  };
}

export interface MsmeComputedFigure {
  key: string;
  label: string;
  value: number;
  source: string;
}

function roleOf(ctx: Pick<TaskExecutionContext, "tasks">, finding: Finding) {
  return ctx.tasks.find((task) => task.id === finding.taskId)?.assignedRole;
}

export function msmeComputedFigures(
  ctx: Pick<TaskExecutionContext, "tasks" | "upstreamFindings">,
): MsmeComputedFigure[] {
  const figures: MsmeComputedFigure[] = [];
  const seen = new Set<string>();

  for (const finding of ctx.upstreamFindings) {
    const role = roleOf(ctx, finding) ?? "unknown";

    for (const figure of finding.figures ?? []) {
      const id = `${role}:${figure.key}`;

      if (!seen.has(id)) {
        seen.add(id);
        figures.push({ key: figure.key, label: figure.label, value: figure.value, source: role });
      }
    }
  }

  return figures;
}

function outstandingPosition(reconciliation: PaymentReconciliation) {
  return {
    asOfDate: reconciliation.asOfDate,
    totals: reconciliation.totals,
    openInvoices: reconciliation.lines
      .filter((line) => line.outstanding > 0)
      .map((line) => ({
        invoiceNumber: line.invoice.invoiceNumber,
        invoiceDate: line.invoice.invoiceDate,
        amount: line.amount,
        outstanding: line.outstanding,
        dueDate: line.dueDate,
        daysOverdue: line.daysOverdue,
      })),
  };
}

export const NO_PAYMENT_DATA_MESSAGE =
  "The outstanding balance could not be reconciled because no readable invoice register was found. Uploaded invoice copies may show individual amounts, but they do not establish the full balance or payments received. Confirm the complete invoice and payment records before relying on a total.";

export const UNVERIFIABLE_PAYMENT_DATA_MESSAGE =
  "The outstanding balance could not be verified because known invoice or payment records could not be read safely. Readable rows may omit invoices or receipts; resolve the record-reading issues and confirm the complete records before stating a balance or making a payment demand.";

function paymentDataIssueMessage(reconciliation: PaymentReconciliation): string {
  const hasRecordReadingFailures =
    reconciliation.records.unreadable.length > 0 ||
    reconciliation.records.unclassified.some((table) => table.recordKind !== undefined);

  return hasRecordReadingFailures || hasPaymentData(reconciliation)
    ? UNVERIFIABLE_PAYMENT_DATA_MESSAGE
    : NO_PAYMENT_DATA_MESSAGE;
}

export function paymentSummaryFinding(reconciliation: PaymentReconciliation): AgentFindingInput {
  if (!hasVerifiablePaymentData(reconciliation)) {
    return {
      summary:
        paymentDataIssueMessage(reconciliation) === NO_PAYMENT_DATA_MESSAGE
          ? "Outstanding amount not computed: no readable invoice register"
          : "Outstanding amount not computed: invoice or payment records could not be read safely",
      severity: "info",
      confidence: "high",
      evidence: [],
      openQuestions: [{ text: paymentDataIssueMessage(reconciliation), severity: "high" }],
    };
  }

  const open = reconciliation.lines.filter((line) => line.outstanding > 0);

  return {
    summary: `Verified payment position: ${formatInrAmount(reconciliation.totals.outstanding)} outstanding across ${open.length} invoice(s) as of ${reconciliation.asOfDate}`,
    severity: reconciliation.totals.outstanding > 0 ? "high" : "info",
    confidence: reconciliation.lines.some((line) => line.inferred) ? "medium" : "high",
    evidence: dedupeEvidenceReferences([
      ...reconciliation.lines.flatMap((line) => [
        recordRowEvidence(line.invoice, `${line.invoice.invoiceNumber} invoice row`),
        ...line.allocations.map((allocation) =>
          recordRowEvidence(
            allocation.payment,
            `Payment ${allocation.payment.label} applied to ${line.invoice.invoiceNumber}`,
          ),
        ),
      ]),
      // A register whose invoices all fall after the cutoff still supports the zero result.
      ...(reconciliation.lines.length === 0
        ? reconciliation.records.tables
            .filter((table) => table.kind === "invoices")
            .map((table) => ({
              documentId: table.documentId,
              description: "Invoice register with no invoices dated on or before the as-of date",
              ...(table.location.sheet ? { sheet: table.location.sheet } : {}),
              ...(table.location.cellRange ? { cellRange: table.location.cellRange } : {}),
            }))
        : []),
    ]),
    figures: [
      {
        key: MSME_FIGURE_KEYS.outstandingTotal,
        label: "Total outstanding",
        value: reconciliation.totals.outstanding,
        unit: "INR",
        components: open.map((line) => ({
          label: `${line.invoice.invoiceNumber} outstanding`,
          value: line.outstanding,
        })),
      },
    ],
  };
}

export function paymentSummaryMarkdown(reconciliation: PaymentReconciliation): string {
  if (!hasVerifiablePaymentData(reconciliation)) {
    return paymentDataIssueMessage(reconciliation);
  }

  const { totals } = reconciliation;
  const open = reconciliation.lines.filter((line) => line.outstanding > 0);
  const unallocated = unallocatedPaymentsMarkdown(reconciliation);
  const parts = [
    `**Outstanding as of ${reconciliation.asOfDate}: ${formatInrAmount(totals.outstanding)}** across ${open.length} invoice(s), from ${formatInrAmount(totals.invoiced)} invoiced less ${formatInrAmount(totals.received)} received and applied.`,
    "",
    paymentSummaryTableMarkdown(reconciliation),
  ];

  if (unallocated) {
    parts.push(
      "",
      `**Payments not applied (${formatInrAmount(totals.unallocated)}, not deducted)**`,
      "",
      unallocated,
    );
  }

  return parts.join("\n");
}

const DOCUMENT_USE_LABELS: Readonly<Record<DocumentEventKind, string>> = {
  agreement: "agreed terms",
  "purchase-order": "purchase order",
  delivery: "delivery",
  "invoice-copy": "invoice details",
  correspondence: "correspondence",
  other: "other events",
};

interface SupportingDocument {
  documentId: string;
  name: string;
  uses: string[];
  events: number;
}

export function supportingDocuments(
  prepared: EvidenceAnalysisPrepared,
  documentNames: ReadonlyMap<string, string>,
): SupportingDocument[] {
  const byId = new Map<string, SupportingDocument>();
  const entry = (documentId: string) => {
    const existing = byId.get(documentId);

    if (existing) {
      return existing;
    }

    const created: SupportingDocument = {
      documentId,
      name: documentNames.get(documentId) ?? documentId,
      uses: [],
      events: 0,
    };

    byId.set(documentId, created);

    return created;
  };

  const addUse = (documentId: string, use: string) => {
    const item = entry(documentId);

    if (!item.uses.includes(use)) {
      item.uses.push(use);
    }
  };

  for (const table of prepared.records.tables) {
    addUse(
      table.documentId,
      `${table.kind === "invoices" ? "invoice register" : "payment records"} (${table.rowCount} row(s))`,
    );
  }

  for (const fact of prepared.facts.events) {
    const documentId = fact.evidence[0]?.documentId;

    if (documentId) {
      addUse(documentId, DOCUMENT_USE_LABELS[fact.kind]);
    }
  }

  for (const source of prepared.terms.terms?.sources ?? []) {
    addUse(source.documentId, `credit period (${source.creditDays} days, p.${source.page})`);
  }

  for (const event of prepared.chronology) {
    if (event.documentId) {
      entry(event.documentId).events += 1;
    }
  }

  return [...byId.values()];
}

function supportingDocumentsMarkdown(
  documents: readonly SupportingDocument[],
  prepared: EvidenceAnalysisPrepared,
): string {
  const pages = paymentPagesToVerify(prepared.documents);
  const rows = documents.map((document) => {
    const lowPages = pages.filter((page) => page.documentId === document.documentId);

    return [
      document.name,
      document.uses.join("; "),
      String(document.events),
      lowPages.length > 0
        ? lowPages
            .map((page) => `p.${page.page} ${page.method} ${Math.round(page.confidence * 100)}%`)
            .join("; ")
        : "-",
    ];
  });

  return markdownTableOf(["Document", "Relied on for", "Chronology events", "To verify"], rows);
}

function supportingDocumentsFinding(documents: readonly SupportingDocument[]): AgentFindingInput {
  return {
    summary: `${documents.length} document(s) support the case pack`,
    severity: "info",
    confidence: "high",
    evidence: documents.map((document) => ({
      documentId: document.documentId,
      description: `Relied on for ${document.uses.join("; ")}`,
    })),
  };
}

function chronologyPackFinding(events: readonly ChronologyEvent[]): AgentFindingInput {
  const finding = chronologyFinding(events);

  delete finding.dates;

  return finding;
}

const SEVERITY_ORDER: readonly OpenQuestionSeverity[] = ["high", "medium", "low"];

function isVerifyFlag(text: string): boolean {
  return text.startsWith(VERIFY_AGAINST_CURRENT_LAW);
}

export function casePackQuestionsMarkdown(
  ctx: Pick<TaskExecutionContext, "tasks" | "task" | "upstreamFindings">,
  prepared: EvidenceAnalysisPrepared,
  own: readonly OpenQuestionDraft[],
): string {
  const titleOf = (taskId: string) => ctx.tasks.find((task) => task.id === taskId)?.title ?? taskId;
  const disputes = ctx.upstreamFindings.filter(
    (finding) =>
      roleOf(ctx, finding) === "evidence-analysis" && /\bDisputed:/.test(finding.summary),
  );
  const parts: string[] = [];
  const list = (title: string, items: readonly string[]) => {
    parts.push(
      `**${title}**`,
      ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- None found."]),
      "",
    );
  };

  list(
    "Missing documents",
    prepared.missingDocuments.map((gap) => gap.summary),
  );
  list(
    "Inconsistencies",
    prepared.inconsistencies.map((gap) => gap.summary),
  );
  list(
    "Disputed items",
    disputes.map((finding) => finding.summary),
  );

  const questions = [
    ...ctx.upstreamFindings.flatMap((finding) =>
      finding.openQuestions
        .filter((question) => question.status === "open")
        .map((question) => ({ ...question, from: titleOf(finding.taskId) })),
    ),
    ...own.map((question) => ({ ...question, from: ctx.task.title })),
  ];
  const seen = new Set<string>();
  const unique = questions.filter((question) => {
    if (seen.has(question.text)) {
      return false;
    }

    seen.add(question.text);

    return true;
  });
  const flags = unique.filter((question) => isVerifyFlag(question.text));

  if (flags.length > 0) {
    parts.push(
      `**${VERIFY_AGAINST_CURRENT_LAW}**`,
      ...flags.map((question) => `- ${question.text}`),
      "",
    );
  }

  for (const severity of SEVERITY_ORDER) {
    const group = unique.filter(
      (question) => question.severity === severity && !isVerifyFlag(question.text),
    );

    if (group.length > 0) {
      parts.push(
        `**Open questions: ${severity} priority**`,
        ...group.map((question) => `- ${question.text} (${question.from})`),
        "",
      );
    }
  }

  const assumptions = [...new Set(ctx.upstreamFindings.flatMap((finding) => finding.assumptions))];

  if (assumptions.length > 0) {
    parts.push("**Assumptions**", ...assumptions.map((assumption) => `- ${assumption}`));
  }

  return parts.join("\n").trim();
}

export function followUpDraftMarkdown(
  draft: FollowUpDraft,
  _knownIds: ReadonlySet<string>,
): string {
  const parts: string[] = [MSME_PAYMENT_GUARDRAIL, "", `Subject: ${draft.subject}`];

  if (draft.salutation) {
    parts.push("", draft.salutation);
  }

  draft.parts.forEach((part, index) => {
    const title = part.title.replace(/^\s*\d+[.)]\s*/, "");
    parts.push("", `${index + 1}. ${title}`, part.content.trim());
  });

  if (draft.closing) {
    parts.push("", draft.closing);
  }

  return parts.join("\n");
}

function draftPartFinding(
  part: FollowUpDraft["parts"][number],
  upstream: readonly Finding[],
): AgentFindingInput {
  const referenced = upstream.filter((finding) => part.findingIds.includes(finding.id));
  const evidence: EvidenceReference[] = referenced
    .flatMap((finding) => finding.evidence)
    .slice(0, MAX_EVIDENCE_PER_DRAFT_PART)
    .map((item) => ({ evidenceId: item.id, description: item.description }));

  return {
    summary: `Draft point: ${part.title}`,
    ...(referenced.length > 0
      ? {
          detail: `Relies on:\n- ${referenced.map((finding) => finding.summary).join("\n- ")}`,
        }
      : {}),
    severity: "info",
    confidence: referenced.length > 0 ? "medium" : "low",
    evidence,
  };
}

export function casePreparationTaskOutput(
  result: AgentResult<CasePreparationOutput>,
  ctx: TaskExecutionContext,
  prepared: EvidenceAnalysisPrepared,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);
  const { reconciliation, chronology } = prepared;
  const paymentDataAvailable = hasVerifiablePaymentData(reconciliation);
  const sourceDraft = paymentDataAvailable ? result.output.draft : undefined;
  const conditionedDraft = sourceDraft ? conditionLegalClaims(sourceDraft) : undefined;
  const draft = conditionedDraft?.draft;
  const documentNames = new Map(
    ctx.documentMetadata.map((metadata) => [metadata.id, metadata.name]),
  );
  const documents = supportingDocuments(prepared, documentNames);
  const knownIds = new Set(ctx.upstreamFindings.map((finding) => finding.id));
  const findings: AgentFindingInput[] = [
    paymentSummaryFinding(reconciliation),
    chronologyPackFinding(chronology),
    supportingDocumentsFinding(documents),
  ];
  const openQuestions: OpenQuestionDraft[] = [];
  const sections: TaskSectionDraft[] = [
    {
      title: PAYMENT_SUMMARY_SECTION_TITLE,
      kind: "table",
      content: paymentSummaryMarkdown(reconciliation),
      findingIndexes: [0],
    },
    {
      title: CHRONOLOGY_SECTION_TITLE,
      kind: "timeline",
      content: chronologyTimelineText(chronology),
      findingIndexes: [1],
    },
    {
      title: SUPPORTING_DOCUMENTS_SECTION_TITLE,
      kind: "table",
      content: supportingDocumentsMarkdown(documents, prepared),
      findingIndexes: [2],
    },
  ];

  if (!paymentDataAvailable && result.output.draft) {
    sections.push({
      title: FOLLOW_UP_DRAFT_SECTION_TITLE,
      kind: "text",
      content: `A follow-up draft has been withheld because the invoice and payment records are not sufficient to verify the outstanding balance. ${paymentDataIssueMessage(reconciliation)}`,
      findingIndexes: [],
    });
    openQuestions.push({
      text: `A follow-up draft was withheld. ${paymentDataIssueMessage(reconciliation)}`,
      severity: "high",
    });
  }

  if (conditionedDraft?.changed) {
    openQuestions.push({
      text: "A statutory-interest statement in the draft was changed to conditional wording. Confirm supplier eligibility, relevant dates, and current law with an adviser before relying on the route.",
      severity: "high",
    });
  }

  if (draft) {
    const start = findings.length;

    findings.push(...draft.parts.map((part) => draftPartFinding(part, ctx.upstreamFindings)));
    sections.push({
      title:
        draft.kind === "escalation"
          ? ESCALATION_DRAFT_SECTION_TITLE
          : FOLLOW_UP_DRAFT_SECTION_TITLE,
      kind: "text",
      content: followUpDraftMarkdown(draft, knownIds),
      findingIndexes: draft.parts.map((_part, index) => start + index),
    });

    const unknown = [
      ...new Set(draft.parts.flatMap((part) => part.findingIds.filter((id) => !knownIds.has(id)))),
    ];

    if (unknown.length > 0) {
      openQuestions.push({
        text: `The draft referred to finding id(s) that are not in the work record (${unknown.join(", ")}); those references were removed.`,
        severity: "low",
      });
    }
  } else if (paymentDataAvailable) {
    for (const section of base.sections ?? []) {
      const conditioned = conditionLegalClaimsInText(section.content);
      sections.push({ ...section, content: conditioned.content });

      if (conditioned.changed) {
        openQuestions.push({
          text: "A statutory-interest statement in the draft was changed to conditional wording. Confirm supplier eligibility, relevant dates, and current law with an adviser before relying on the route.",
          severity: "high",
        });
      }
    }
  }

  const draftText = [
    draft?.subject,
    ...(draft ? draft.parts.map((part) => part.content) : []),
    draft?.closing,
    ...(paymentDataAvailable ? sections.map((section) => section.content) : []),
  ]
    .filter(Boolean)
    .join("\n");

  for (const claim of findEscalationClaims(draftText)) {
    openQuestions.push({
      text: `The draft says "${claim}". Nothing has been sent, filed, or escalated by this platform; correct the wording before use.`,
      severity: "high",
    });
  }

  findings.push(...base.findings);

  const allQuestions = [...openQuestions, ...(base.openQuestions ?? [])];
  const findingQuestions = findings.flatMap((finding) => finding.openQuestions ?? []);

  sections.push({
    title: CASE_PACK_QUESTIONS_SECTION_TITLE,
    kind: "text",
    content: casePackQuestionsMarkdown(ctx, prepared, [...allQuestions, ...findingQuestions]),
    findingIndexes: [],
  });

  return {
    ...base,
    findings,
    openQuestions: allQuestions,
    sections,
    deliverables: [msmePaymentPackSpec()],
  };
}

export interface CasePreparationHandlerOptions extends PaymentReconcileOptions {
  agent?: CasePreparationAgent;
}

/** Assembles the case pack from deterministic records and drafts a follow-up. Never sends or escalates anything. */
export function createCasePreparationTaskHandler(
  options: CasePreparationHandlerOptions = {},
): TaskHandler {
  const { agent, ...reconcileOptions } = options;

  return createPreparedHandler<EvidenceAnalysisPrepared, SpecialistInput, CasePreparationOutput>(
    "case-preparation",
    (ctx) => resolveAgentFor(ctx, "case-preparation", agent, createCasePreparationAgent),
    {
      prepareAsync(ctx) {
        return prepareEvidenceAnalysisAsync(ctx, reconcileOptions);
      },
      buildInput(ctx, prepared) {
        const figures = msmeComputedFigures(ctx);
        const context: Record<string, unknown> = {
          guardrail: MSME_PAYMENT_GUARDRAIL,
          ...(figures.length > 0 ? { computedFigures: figures } : {}),
          ...(hasVerifiablePaymentData(prepared.reconciliation)
            ? { outstandingPosition: outstandingPosition(prepared.reconciliation) }
            : {}),
          chronology: prepared.chronology.map((event) => `${event.date} ${event.title}`),
        };

        return withoutRecordTables(
          buildSpecialistInput(ctx, context),
          recordTableKeys(prepared.records),
        );
      },
      toTaskOutput(result, ctx, prepared) {
        return casePreparationTaskOutput(
          { ...result, output: casePreparationOutputSchema.parse(result.output) },
          ctx,
          prepared,
        );
      },
    },
  );
}
