import type { Finding } from "@evianta/core";
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
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
} from "../../handlers.js";
import { truncate } from "../../text.js";
import {
  buildChronology,
  chronologyTimelineText,
  documentFactsFromFindings,
  findInconsistencies,
  findMissingDocuments,
  type ChronologyEvent,
  type DocumentFacts,
  type EvidenceGap,
} from "./chronology.js";
import { msmePaymentPackSpec } from "./constants.js";
import {
  createPreparedHandler,
  preparePaymentCaseAsync,
  resolveAgentFor,
  withoutRecordTables,
  type PaymentCase,
} from "./context.js";
import { toIsoDate } from "./dates.js";
import { msmeDocumentSourceSchema } from "./documentAnalysis.js";
import { recordDocumentIds } from "./records.js";
import type { PaymentReconcileOptions } from "./reconcile.js";

export const disputedItemSchema = z.object({
  invoiceNumbers: z.array(z.string()).default([]),
  description: z.string().min(1),
  raisedBy: z.string().optional(),
  date: z.string().optional(),
  source: msmeDocumentSourceSchema.optional(),
});

export type DisputedItem = z.infer<typeof disputedItemSchema>;

export const evidenceAnalysisOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  summary: z.string().optional(),
  disputedItems: z.array(disputedItemSchema).default([]),
});

export type EvidenceAnalysisOutput = z.infer<typeof evidenceAnalysisOutputSchema>;

export type EvidenceAnalysisAgent = Agent<SpecialistInput, EvidenceAnalysisOutput>;

export const EVIDENCE_ANALYSIS_SYSTEM_PROMPT = [
  "You are the evidence analyst preparing an MSME supplier's overdue-payment case for the business owner or adviser to review.",
  "context.chronology is a deterministic, source-linked chronology; context.missingDocuments and context.inconsistencies were found by deterministic checks. Do not repeat or change them.",
  "Read the correspondence and other documents and list every disputed item in disputedItems: what the buyer (or supplier) disputes, the invoices it concerns, who raised it and when, and a source with the documentId, 1-based page, and a short verbatim quote.",
  "Add findings only for other gaps or inconsistencies the deterministic checks could not see, each citing evidence. Put a short overview of the evidence position in summary.",
  "Describe disputes neutrally. Do not decide who is right or make any legal determination.",
].join("\n");

export function createEvidenceAnalysisAgent(): EvidenceAnalysisAgent {
  const { profile } = SPECIALIST_DEFINITIONS["evidence-analysis"];

  return defineAgent<SpecialistInput, EvidenceAnalysisOutput>({
    role: "evidence-analysis",
    modelTier: profile.modelTier,
    systemPrompt: EVIDENCE_ANALYSIS_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: evidenceAnalysisOutputSchema,
    grounding: false,
    maxOutputTokens: 4096,
    profile,
  });
}

/** Findings of the document-analysis tasks, the only source of document events. */
export function documentAnalysisFindings(
  ctx: Pick<TaskExecutionContext, "tasks" | "upstreamFindings">,
): Finding[] {
  const ids = new Set(
    ctx.tasks.filter((task) => task.assignedRole === "document-analysis").map((task) => task.id),
  );

  return ctx.upstreamFindings.filter((finding) => ids.has(finding.taskId));
}

export interface EvidenceAnalysisPrepared extends PaymentCase {
  facts: DocumentFacts;
  chronology: ChronologyEvent[];
  missingDocuments: EvidenceGap[];
  inconsistencies: EvidenceGap[];
}

export async function prepareEvidenceAnalysisAsync(
  ctx: TaskExecutionContext,
  options: PaymentReconcileOptions = {},
): Promise<EvidenceAnalysisPrepared> {
  const prepared = await preparePaymentCaseAsync(ctx, options);
  const facts = documentFactsFromFindings(documentAnalysisFindings(ctx));

  return {
    ...prepared,
    facts,
    chronology: buildChronology(prepared.reconciliation, facts),
    missingDocuments: findMissingDocuments(prepared.reconciliation, facts),
    inconsistencies: findInconsistencies(prepared.reconciliation, facts),
  };
}

function evidenceKey(reference: EvidenceReference): string {
  return (
    reference.evidenceId ??
    `${reference.documentId}|${reference.sheet ?? ""}|${reference.page ?? ""}|${reference.cellRange ?? ""}|${reference.rowStart ?? ""}|${reference.textQuote ?? ""}`
  );
}

export function dedupeEvidenceReferences(
  references: readonly EvidenceReference[],
): EvidenceReference[] {
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = evidenceKey(reference);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/** One finding for the whole chronology; each event's date and evidence travel with it. */
export function chronologyFinding(events: readonly ChronologyEvent[]): AgentFindingInput {
  const first = events[0];
  const last = events.at(-1);

  return {
    summary:
      first && last
        ? `Chronology of ${events.length} event(s) from ${first.date} to ${last.date}`
        : "No dated events were found",
    detail: chronologyTimelineText(events),
    severity: "info",
    confidence: events.some((event) => event.confidence === "low") ? "medium" : "high",
    // Every event keeps its sources, so the timeline never shows an event without a link.
    evidence: dedupeEvidenceReferences(events.flatMap((event) => event.evidence)),
    dates: events.map((event) => ({ key: event.dateKey, label: event.title, date: event.date })),
  };
}

export function gapFinding(gap: EvidenceGap): AgentFindingInput {
  return {
    summary: gap.summary,
    severity: gap.severity,
    confidence: "high",
    evidence: gap.evidence,
    openQuestions: [{ text: gap.question, severity: gap.questionSeverity ?? gap.severity }],
  };
}

export function disputedItemFinding(item: DisputedItem): AgentFindingInput {
  const refs = item.invoiceNumbers.length > 0 ? `[${item.invoiceNumbers.join(", ")}] ` : "";
  const date = toIsoDate(item.date);
  const raised = [
    item.raisedBy ? `raised by ${item.raisedBy}` : undefined,
    date ? `on ${date}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    summary: `${refs}Disputed: ${truncate(item.description, 200)}`,
    ...(raised ? { detail: `Dispute ${raised}.` } : {}),
    severity: "high",
    confidence: "medium",
    evidence: item.source
      ? [
          {
            documentId: item.source.documentId,
            description: `Dispute${item.invoiceNumbers.length > 0 ? ` over ${item.invoiceNumbers.join(", ")}` : ""}`,
            ...(item.source.page !== undefined ? { page: item.source.page } : {}),
            ...(item.source.quote?.trim() ? { textQuote: item.source.quote.trim() } : {}),
          },
        ]
      : [],
    openQuestions: [
      {
        text: `${refs}Disputed item: ${truncate(item.description, 200)}. Gather the documents that answer it before any follow-up or escalation.`,
        severity: "high",
      },
    ],
  };
}

function gapLines(title: string, gaps: readonly EvidenceGap[]): string[] {
  return gaps.length > 0 ? ["", `**${title}**`, ...gaps.map((gap) => `- ${gap.summary}`)] : [];
}

export function evidenceAnalysisMarkdown(
  prepared: EvidenceAnalysisPrepared,
  output: EvidenceAnalysisOutput,
): string {
  const first = prepared.chronology[0];
  const last = prepared.chronology.at(-1);
  const parts = [
    output.summary?.trim() || "Evidence position for the overdue invoices.",
    "",
    first && last
      ? `The chronology has ${prepared.chronology.length} source-linked event(s) from ${first.date} to ${last.date}; it is set out in the case pack.`
      : "No dated events were found.",
    ...gapLines("Missing documents", prepared.missingDocuments),
    ...gapLines("Inconsistencies", prepared.inconsistencies),
  ];

  if (output.disputedItems.length > 0) {
    parts.push(
      "",
      "**Disputed items**",
      ...output.disputedItems.map((item) => `- ${disputedItemFinding(item).summary}`),
    );
  }

  if (
    prepared.missingDocuments.length === 0 &&
    prepared.inconsistencies.length === 0 &&
    output.disputedItems.length === 0 &&
    output.findings.length === 0
  ) {
    parts.push("", "No missing documents, inconsistencies, or disputed items were found.");
  }

  return parts.join("\n");
}

export function evidenceAnalysisTaskOutput(
  result: AgentResult<EvidenceAnalysisOutput>,
  prepared: EvidenceAnalysisPrepared,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);
  const findings: AgentFindingInput[] = [
    chronologyFinding(prepared.chronology),
    ...prepared.missingDocuments.map(gapFinding),
    ...prepared.inconsistencies.map(gapFinding),
    ...result.output.disputedItems.map(disputedItemFinding),
    ...base.findings,
  ];

  return {
    ...base,
    findings,
    sections: [
      {
        title: "Evidence analysis: missing documents, inconsistencies, and disputed items",
        kind: "text",
        content: evidenceAnalysisMarkdown(prepared, result.output),
        findingIndexes: findings.map((_finding, index) => index),
      },
    ],
    deliverables: [msmePaymentPackSpec()],
  };
}

export interface EvidenceAnalysisHandlerOptions extends PaymentReconcileOptions {
  agent?: EvidenceAnalysisAgent;
}

/** Deterministic chronology, missing-document, and inconsistency checks; the model reads disputes. */
export function createEvidenceAnalysisTaskHandler(
  options: EvidenceAnalysisHandlerOptions = {},
): TaskHandler {
  const { agent, ...reconcileOptions } = options;

  return createPreparedHandler<EvidenceAnalysisPrepared, SpecialistInput, EvidenceAnalysisOutput>(
    "evidence-analysis",
    (ctx) => resolveAgentFor(ctx, "evidence-analysis", agent, createEvidenceAnalysisAgent),
    {
      prepareAsync(ctx) {
        return prepareEvidenceAnalysisAsync(ctx, reconcileOptions);
      },
      buildInput(ctx, prepared) {
        const context = {
          chronology: prepared.chronology.map((event) => ({
            date: event.date,
            kind: event.kind,
            event: event.title,
            source: event.source,
          })),
          missingDocuments: prepared.missingDocuments.map((gap) => gap.summary),
          inconsistencies: prepared.inconsistencies.map((gap) => gap.summary),
        };

        return withoutRecordTables(
          buildSpecialistInput(ctx, context),
          recordDocumentIds(prepared.records),
        );
      },
      toTaskOutput(result, _ctx, prepared) {
        return evidenceAnalysisTaskOutput(
          { ...result, output: evidenceAnalysisOutputSchema.parse(result.output) },
          prepared,
        );
      },
    },
  );
}
