import { confidenceLevelSchema } from "@evianta/core";
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
  type TaskHandler,
  type TaskOutput,
  type TaskSectionDraft,
} from "../../handlers.js";
import {
  reconciliationLineFigureKey,
  taxNoticePackSpec,
  TAX_FIGURE_KEYS,
  formatRupees,
} from "./constants.js";
import { createPreparedTaskHandler, reconcileCaseAsync, type CaseRecords } from "./context.js";
import { SOURCE_LABELS, taxRecordDocumentIds, type TaxRecordSource } from "./records.js";
import {
  discrepancies,
  hasReconciliationData,
  lineDifferenceComponents,
  primaryTaxDifference,
  sourceLabel,
  type TaxReconcileOptions,
  type ReconciliationLine,
  type TaxReconciliation,
} from "./reconcile.js";
import { lineEvidence, reconciliationTableMarkdown } from "./render.js";

export const MAX_MATCHED_EVIDENCE = 24;

export const differenceExplanationSchema = z.object({
  ref: z.string().min(1),
  explanation: z.string().min(1),
  likelyCause: z.string().optional(),
  followUp: z.string().optional(),
  confidence: confidenceLevelSchema.default("medium"),
});

export type DifferenceExplanation = z.infer<typeof differenceExplanationSchema>;

export const reconciliationOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  summary: z.string().optional(),
  explanations: z.array(differenceExplanationSchema).default([]),
});

export type ReconciliationOutput = z.infer<typeof reconciliationOutputSchema>;

export type ReconciliationAgent = Agent<SpecialistInput, ReconciliationOutput>;

export const RECONCILIATION_SYSTEM_PROMPT = [
  "You are the reconciliation specialist preparing an income-tax notice response for a Chartered Accountant to review.",
  "context.reconciliation holds a deterministic reconciliation of the return, the books (ledger), and the 26AS/AIS tax-credit statement. Its numbers are exact and final: never recompute, round, or restate them differently.",
  "For each line in context.reconciliation.discrepancies, add an explanations entry with its ref: explain the likely reason for the difference in plain language (for example a deductor not reporting a quarter, a wrong TAN, a timing difference, or income booked in another year), the likely cause, and a concrete follow-up for the professional (for example obtaining a revised TDS statement from the deductor).",
  "Use the notice findings in priorFindings to connect the differences to the issues the notice raises. Put a one-paragraph overview in summary.",
  "When context.reconciliation is missing or has no data, explain from the documents what could not be reconciled and raise high-severity openQuestions for the records needed.",
  "Do not make legal determinations, and do not state any figure that is not in context or the documents.",
].join("\n");

export function createReconciliationAgent(): ReconciliationAgent {
  const { profile } = SPECIALIST_DEFINITIONS.reconciliation;

  return defineAgent<SpecialistInput, ReconciliationOutput>({
    role: "reconciliation",
    modelTier: profile.modelTier,
    systemPrompt: RECONCILIATION_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: reconciliationOutputSchema,
    maxOutputTokens: 4096,
    profile,
  });
}

function lineSummaryForModel(line: ReconciliationLine) {
  return {
    ref: line.ref,
    deductor: line.deductorName,
    ...(line.tan ? { tan: line.tan } : {}),
    ...(line.section ? { section: line.section } : {}),
    period: line.period,
    status: line.status,
    ...(line.missingIn.length > 0 ? { missingIn: line.missingIn.map(sourceLabel) } : {}),
    values: Object.fromEntries(
      Object.entries(line.values).map(([source, values]) => [
        sourceLabel(source as TaxRecordSource),
        {
          ...(values?.amount !== undefined ? { amount: values.amount } : {}),
          ...(values?.tax !== undefined ? { tds: values.tax } : {}),
          rows: values?.rows.length ?? 0,
        },
      ]),
    ),
    ...(primaryTaxDifference(line) !== undefined
      ? { tdsDifference: primaryTaxDifference(line) }
      : {}),
  };
}

/** A compact, token-cheap view of the reconciliation for the model. */
export function reconciliationContext(reconciliation: TaxReconciliation): Record<string, unknown> {
  const matched = reconciliation.lines.filter((line) => line.status === "matched");

  return {
    reconciliation: {
      tolerance: reconciliation.tolerance,
      sourcesProvided: reconciliation.providedSources.map(sourceLabel),
      sourcesMissing: reconciliation.missingSources.map(sourceLabel),
      totals: Object.fromEntries(
        Object.entries(reconciliation.totals.bySource).map(([source, totals]) => [
          sourceLabel(source as TaxRecordSource),
          totals,
        ]),
      ),
      ...(reconciliation.totals.returnVsTaxCredit
        ? { returnLess26AS: reconciliation.totals.returnVsTaxCredit }
        : {}),
      ...(reconciliation.totals.ledgerVsTaxCredit
        ? { ledgerLess26AS: reconciliation.totals.ledgerVsTaxCredit }
        : {}),
      matched: { count: matched.length, refs: matched.map((line) => line.ref) },
      discrepancies: discrepancies(reconciliation).map(lineSummaryForModel),
      unreadTables: reconciliation.unclassified.map(
        (table) => `${table.documentName} (${table.reason})`,
      ),
    },
  };
}

function discrepancySummary(line: ReconciliationLine): string {
  const who = line.tan ? `${line.deductorName} (${line.tan})` : line.deductorName;

  if (line.status === "missing") {
    const present = Object.keys(line.values).map((source) =>
      sourceLabel(source as TaxRecordSource),
    );

    return `[${line.ref}] ${who}, ${line.period}: in ${present.join(" and ")} but missing in ${line.missingIn.map(sourceLabel).join(" and ")}`;
  }

  const parts = (["return", "ledger", "tax-credit"] as const)
    .filter((source) => line.values[source]?.tax !== undefined)
    .map((source) => `${SOURCE_LABELS[source]} ${formatRupees(line.values[source]?.tax ?? 0)}`);

  return `[${line.ref}] TDS mismatch for ${who}, ${line.period}: ${parts.join(" vs ")}`;
}

function explanationDetail(explanation: DifferenceExplanation | undefined): string {
  if (!explanation) {
    return "No explanation was produced for this difference; review the cited rows.";
  }

  return [
    explanation.explanation,
    explanation.likelyCause ? `Likely cause: ${explanation.likelyCause}` : undefined,
    explanation.followUp ? `Suggested follow-up: ${explanation.followUp}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function discrepancyFinding(
  line: ReconciliationLine,
  tolerance: number,
  explanation?: DifferenceExplanation,
): AgentFindingInput {
  const delta = primaryTaxDifference(line);
  const taxImpact = delta !== undefined && Math.abs(delta) > tolerance;
  const openQuestions: OpenQuestionDraft[] = explanation?.followUp
    ? [{ text: `${line.ref}: ${explanation.followUp}`, severity: taxImpact ? "high" : "medium" }]
    : [];

  return {
    summary: discrepancySummary(line),
    detail: explanationDetail(explanation),
    severity: taxImpact ? "high" : "medium",
    confidence: "high",
    evidence: lineEvidence(line),
    openQuestions,
    ...(delta !== undefined
      ? {
          figures: [
            {
              key: reconciliationLineFigureKey(line.ref),
              label: `${line.ref} TDS difference`,
              value: delta,
              unit: "INR",
              components: lineDifferenceComponents(line),
            },
          ],
        }
      : {}),
  };
}

export function matchedFinding(reconciliation: TaxReconciliation): AgentFindingInput | undefined {
  const matched = reconciliation.lines.filter((line) => line.status === "matched");

  if (matched.length === 0) {
    return undefined;
  }

  const evidence: EvidenceReference[] = matched
    .flatMap((line) => lineEvidence(line))
    .slice(0, MAX_MATCHED_EVIDENCE);

  return {
    summary: `${matched.length} item(s) agree across ${reconciliation.providedSources.map(sourceLabel).join(", ")} within Rs ${reconciliation.tolerance}`,
    detail: matched
      .map(
        (line) =>
          `[${line.ref}] ${line.deductorName}${line.tan ? ` (${line.tan})` : ""}, ${line.period}`,
      )
      .join("\n"),
    severity: "info",
    confidence: "high",
    evidence,
  };
}

function totalsComponents(reconciliation: TaxReconciliation, source: TaxRecordSource) {
  return reconciliation.lines
    .filter((line) => line.values[source]?.tax !== undefined)
    .map((line) => ({ label: line.ref, value: line.values[source]?.tax ?? 0 }));
}

export function totalsFinding(reconciliation: TaxReconciliation): AgentFindingInput {
  const { bySource, returnVsTaxCredit, ledgerVsTaxCredit } = reconciliation.totals;
  const tdsKeys: Record<TaxRecordSource, string> = {
    return: TAX_FIGURE_KEYS.tdsClaimedInReturn,
    ledger: TAX_FIGURE_KEYS.tdsPerLedger,
    "tax-credit": TAX_FIGURE_KEYS.tdsPerTaxCredit,
  };
  const incomeKeys: Record<TaxRecordSource, string> = {
    return: TAX_FIGURE_KEYS.incomePerReturn,
    ledger: TAX_FIGURE_KEYS.incomePerLedger,
    "tax-credit": TAX_FIGURE_KEYS.incomePerTaxCredit,
  };
  const figures: NonNullable<AgentFindingInput["figures"]> = [];

  for (const source of reconciliation.providedSources) {
    const totals = bySource[source];

    if (!totals) {
      continue;
    }

    const components = totalsComponents(reconciliation, source);
    const hasAmounts = reconciliation.lines.some(
      (line) => line.values[source]?.amount !== undefined,
    );

    if (components.length > 0) {
      figures.push({
        key: tdsKeys[source],
        label: `Total TDS per ${sourceLabel(source)}`,
        value: totals.tax,
        unit: "INR",
        components,
      });
    }

    if (hasAmounts) {
      figures.push({
        key: incomeKeys[source],
        label: `Total amount per ${sourceLabel(source)}`,
        value: totals.amount,
        unit: "INR",
      });
    }
  }

  if (returnVsTaxCredit && bySource.return && bySource["tax-credit"]) {
    figures.push({
      key: TAX_FIGURE_KEYS.tdsDifference,
      label: "TDS claimed in the return less TDS per 26AS/AIS",
      value: returnVsTaxCredit.tax,
      unit: "INR",
      components: [
        { label: "TDS per return", value: bySource.return.tax },
        { label: "TDS per 26AS/AIS", value: -bySource["tax-credit"].tax },
      ],
    });
  }

  if (ledgerVsTaxCredit && bySource.ledger && bySource["tax-credit"]) {
    figures.push({
      key: TAX_FIGURE_KEYS.ledgerTdsDifference,
      label: "TDS per ledger less TDS per 26AS/AIS",
      value: ledgerVsTaxCredit.tax,
      unit: "INR",
      components: [
        { label: "TDS per ledger", value: bySource.ledger.tax },
        { label: "TDS per 26AS/AIS", value: -bySource["tax-credit"].tax },
      ],
    });
  }

  const headline = returnVsTaxCredit?.tax ?? ledgerVsTaxCredit?.tax;
  const material = headline !== undefined && Math.abs(headline) > reconciliation.tolerance;

  return {
    summary:
      headline === undefined
        ? "Reconciliation totals"
        : `Reconciliation totals: TDS difference of ${formatRupees(headline)} against 26AS/AIS`,
    detail: figures.map((figure) => `${figure.label}: ${formatRupees(figure.value)}`).join("\n"),
    severity: material ? "high" : "info",
    confidence: "high",
    evidence: reconciliation.tables.map((table) => ({
      documentId: table.documentId,
      description: `${sourceLabel(table.source)} records (${table.rowCount} row(s))`,
      ...(table.location.sheet ? { sheet: table.location.sheet } : {}),
      ...(table.location.cellRange ? { cellRange: table.location.cellRange } : {}),
    })),
    figures,
  };
}

export function reconciliationOpenQuestions(
  reconciliation: TaxReconciliation,
): OpenQuestionDraft[] {
  const questions: OpenQuestionDraft[] = reconciliation.missingSources.map((source) => ({
    text: `No ${sourceLabel(source)} records were found among the uploaded documents, so that side of the reconciliation is incomplete. Upload them or confirm they are not needed.`,
    severity: source === "tax-credit" || source === "return" ? "high" : "medium",
  }));

  for (const table of reconciliation.unclassified) {
    questions.push({
      text: `The table in ${table.documentName} was not reconciled: ${table.reason}. Confirm whether it holds relevant records.`,
      severity: "low",
    });
  }

  return questions;
}

function notesMarkdown(
  reconciliation: TaxReconciliation,
  output: ReconciliationOutput,
  explanations: ReadonlyMap<string, DifferenceExplanation>,
): string {
  const lines = discrepancies(reconciliation);
  const parts = [output.summary?.trim() || "Explanation of the reconciliation differences."];

  for (const line of lines) {
    parts.push(
      "",
      `**${discrepancySummary(line)}**`,
      explanationDetail(explanations.get(line.ref)),
    );
  }

  if (lines.length === 0) {
    parts.push("", "Every reconciled item agrees within the tolerance.");
  }

  return parts.join("\n");
}

export function reconciliationTaskOutput(
  result: AgentResult<ReconciliationOutput>,
  reconciliation: TaxReconciliation,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);

  if (!hasReconciliationData(reconciliation)) {
    return { ...base, deliverables: [taxNoticePackSpec()] };
  }

  const explanations = new Map(result.output.explanations.map((entry) => [entry.ref, entry]));
  const deterministic: AgentFindingInput[] = [
    ...discrepancies(reconciliation).map((line) =>
      discrepancyFinding(line, reconciliation.tolerance, explanations.get(line.ref)),
    ),
  ];
  const matched = matchedFinding(reconciliation);

  if (matched) {
    deterministic.push(matched);
  }

  deterministic.push(totalsFinding(reconciliation));

  const tableIndexes = deterministic.map((_finding, index) => index);
  const findings = [...deterministic, ...base.findings];
  const sections: TaskSectionDraft[] = [
    {
      title: "Reconciliation: return, ledger, and 26AS/AIS",
      kind: "table",
      content: reconciliationTableMarkdown(reconciliation),
      findingIndexes: tableIndexes,
    },
    {
      title: "Reconciliation notes",
      kind: "text",
      content: notesMarkdown(reconciliation, result.output, explanations),
      findingIndexes: deterministic
        .map((finding, index) => (finding.severity === "info" ? -1 : index))
        .filter((index) => index >= 0),
    },
  ];
  const unknownRefs = result.output.explanations
    .map((entry) => entry.ref)
    .filter((ref) => !reconciliation.lines.some((line) => line.ref === ref));

  return {
    ...base,
    findings,
    openQuestions: [
      ...reconciliationOpenQuestions(reconciliation),
      ...(base.openQuestions ?? []),
      ...(unknownRefs.length > 0
        ? [
            {
              text: `The reconciliation explanation referred to unknown line(s) ${unknownRefs.join(", ")}; those explanations were ignored.`,
              severity: "low" as const,
            },
          ]
        : []),
    ],
    sections,
    deliverables: [taxNoticePackSpec()],
  };
}

export interface ReconciliationHandlerOptions extends TaxReconcileOptions {
  agent?: ReconciliationAgent;
}

/** Deterministic reconciliation in TypeScript, then one model call to explain the differences. */
export function createReconciliationTaskHandler(
  options: ReconciliationHandlerOptions = {},
): TaskHandler {
  const agent = options.agent ?? createReconciliationAgent();

  return createPreparedTaskHandler<CaseRecords, SpecialistInput, ReconciliationOutput>(agent, {
    prepareAsync(ctx) {
      return reconcileCaseAsync(ctx, options);
    },
    buildInput(ctx, prepared) {
      if (!hasReconciliationData(prepared.reconciliation)) {
        return buildSpecialistInput(ctx);
      }

      const reconciled = taxRecordDocumentIds(prepared.records);
      const input = buildSpecialistInput(ctx, reconciliationContext(prepared.reconciliation));

      return {
        ...input,
        documents: input.documents.filter(
          (slice) => !(slice.kind === "table" && reconciled.has(slice.documentId)),
        ),
      };
    },
    toTaskOutput(result, _ctx, prepared) {
      return reconciliationTaskOutput(result, prepared.reconciliation);
    },
  });
}
