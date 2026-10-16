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
  formatAmount,
  markdownTable,
  responsePackSpec,
  TAX_FIGURE_KEYS,
  TAX_NOTICE_GUARDRAIL,
} from "./constants.js";
import { createPreparedTaskHandler, reconcileCaseAsync, type CaseRecords } from "./context.js";
import { taxRecordDocumentIds } from "./records.js";
import {
  hasReconciliationData,
  sourceLabel,
  type ReconcileOptions,
  type TaxReconciliation,
} from "./reconcile.js";
import { reconciliationTableMarkdown } from "./render.js";

export const SCHEDULE_TITLE_PREFIX = "Schedule ";
export const SCHEDULE_A = "Schedule A";
export const SCHEDULE_B = "Schedule B";
export const MAX_EVIDENCE_PER_POINT = 6;
export const RESPONSE_DRAFT_SECTION_TITLE = "Response draft";
export const OPEN_QUESTIONS_SECTION_TITLE = "Open questions, assumptions, and verification flags";

export const draftPartSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  /** Ids of the prior findings this part relies on. */
  findingIds: z.array(z.string()).default([]),
  scheduleRefs: z.array(z.string()).default([]),
});

export type DraftPart = z.infer<typeof draftPartSchema>;

export const responseDraftSchema = z.object({
  subject: z.string().min(1),
  salutation: z.string().optional(),
  parts: z.array(draftPartSchema).min(1),
  closing: z.string().optional(),
});

export type ResponseDraft = z.infer<typeof responseDraftSchema>;

export const responsePreparationOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  draft: responseDraftSchema.optional(),
});

export type ResponsePreparationOutput = z.infer<typeof responsePreparationOutputSchema>;

export type ResponsePreparationAgent = Agent<SpecialistInput, ResponsePreparationOutput>;

export const RESPONSE_PREPARATION_SYSTEM_PROMPT = [
  "You draft the response to an income-tax notice for a Chartered Accountant to review, edit, and approve.",
  "Write draft as a formal reply: a subject, an optional salutation, numbered parts that address each issue the notice raises, and an optional closing. Each part lists the findingIds (from priorFindings) it relies on and the scheduleRefs (from context.schedules) it cites.",
  "Quote only figures that appear in context.computedFigures or in priorFindings, exactly as given. Never compute new totals or differences, and never round.",
  "The draft is a proposal for the professional. Never state or imply that anything has been filed, submitted, uploaded, or paid, and do not make legal determinations; where the outcome depends on law or facts not yet confirmed, say what the professional must confirm.",
  "Put anything the professional must decide or obtain in openQuestions with a severity.",
].join("\n");

export function createResponsePreparationAgent(): ResponsePreparationAgent {
  const { profile } = SPECIALIST_DEFINITIONS["response-preparation"];

  return defineAgent<SpecialistInput, ResponsePreparationOutput>({
    role: "response-preparation",
    modelTier: profile.modelTier,
    systemPrompt: RESPONSE_PREPARATION_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: responsePreparationOutputSchema,
    maxOutputTokens: 6144,
    profile,
  });
}

const FILING_CLAIM =
  /\b(has|have|had|was|were|is|are)\s+(been\s+)?(e-?filed|filed|submitted|uploaded)\b|\bwe\s+(have\s+)?(e-?filed|filed|submitted|uploaded)\b|\bhereby\s+(file|submit)\b/i;

/** Sentences that claim a filing or submission happened, which the platform never does. */
export function findFilingClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && FILING_CLAIM.test(sentence));
}

export interface ComputedFigure {
  key: string;
  label: string;
  value: number;
  source: string;
}

function roleOf(ctx: TaskExecutionContext, finding: Finding) {
  return ctx.tasks.find((task) => task.id === finding.taskId)?.assignedRole;
}

export function computedFigures(
  ctx: TaskExecutionContext,
  reconciliation: TaxReconciliation | undefined,
): ComputedFigure[] {
  const figures: ComputedFigure[] = [];
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

  if (reconciliation && hasReconciliationData(reconciliation)) {
    for (const [source, totals] of Object.entries(reconciliation.totals.bySource)) {
      const label = sourceLabel(source as keyof typeof reconciliation.totals.bySource);
      const id = `schedule:${source}`;

      if (totals && !seen.has(id)) {
        seen.add(id);
        figures.push({
          key: `schedule-tds-${source}`,
          label: `${SCHEDULE_A} total TDS per ${label}`,
          value: totals.tax,
          source: SCHEDULE_A,
        });
      }
    }
  }

  return figures;
}

function noticeFigures(ctx: TaskExecutionContext): ComputedFigure[] {
  return ctx.upstreamFindings
    .filter((finding) => roleOf(ctx, finding) === "case-analysis")
    .flatMap((finding) =>
      (finding.figures ?? []).map((figure) => ({
        key: figure.key,
        label: figure.label,
        value: figure.value,
        source: "notice",
      })),
    );
}

export function scheduleBRows(
  reconciliation: TaxReconciliation,
  notice: readonly ComputedFigure[],
): string[][] {
  const { bySource, returnVsTaxCredit } = reconciliation.totals;
  const rows: string[][] = [];

  for (const source of reconciliation.providedSources) {
    const totals = bySource[source];

    if (totals) {
      rows.push([
        `TDS per ${sourceLabel(source)}`,
        formatAmount(totals.tax),
        `${SCHEDULE_A}, ${totals.rowCount} row(s)`,
      ]);
    }
  }

  if (returnVsTaxCredit) {
    rows.push([
      "TDS claimed in the return less TDS per 26AS/AIS",
      formatAmount(returnVsTaxCredit.tax),
      `${SCHEDULE_A} totals`,
    ]);
  }

  for (const figure of notice) {
    rows.push([`Per notice: ${figure.label}`, formatAmount(figure.value), "Notice"]);
  }

  const disallowed = notice.find((figure) => figure.key === TAX_FIGURE_KEYS.tdsDifference);

  if (disallowed && returnVsTaxCredit) {
    rows.push([
      "Notice disallowance less reconciled difference",
      formatAmount(Math.round((disallowed.value - returnVsTaxCredit.tax) * 100) / 100),
      "Notice and reconciliation",
    ]);
  }

  return rows;
}

export interface ScheduleOutput {
  finding: AgentFindingInput;
  sections: TaskSectionDraft[];
}

export function buildSchedules(
  reconciliation: TaxReconciliation,
  notice: readonly ComputedFigure[],
): ScheduleOutput {
  return {
    finding: {
      summary: `${SCHEDULE_A} (TDS reconciliation) and ${SCHEDULE_B} (computation of the difference) prepared from the uploaded records`,
      severity: "info",
      confidence: "high",
      evidence: reconciliation.tables.map((table) => ({
        documentId: table.documentId,
        description: `${sourceLabel(table.source)} records used in the schedules`,
        ...(table.location.sheet ? { sheet: table.location.sheet } : {}),
        ...(table.location.cellRange ? { cellRange: table.location.cellRange } : {}),
      })),
    },
    sections: [
      {
        title: `${SCHEDULE_A}: TDS reconciliation`,
        kind: "table",
        content: reconciliationTableMarkdown(reconciliation),
      },
      {
        title: `${SCHEDULE_B}: Computation of the TDS difference`,
        kind: "table",
        content: markdownTable(
          ["Item", "Amount (Rs)", "Basis"],
          scheduleBRows(reconciliation, notice),
        ),
      },
    ],
  };
}

const SEVERITY_ORDER: readonly OpenQuestionSeverity[] = ["high", "medium", "low"];

export function openQuestionsMarkdown(
  ctx: TaskExecutionContext,
  own: readonly OpenQuestionDraft[],
): string | undefined {
  const titleOf = (taskId: string) => ctx.tasks.find((task) => task.id === taskId)?.title ?? taskId;
  const questions = [
    ...ctx.upstreamFindings.flatMap((finding) =>
      finding.openQuestions
        .filter((question) => question.status === "open")
        .map((question) => ({ ...question, from: titleOf(finding.taskId) })),
    ),
    ...own.map((question) => ({ ...question, from: ctx.task.title })),
  ];
  const assumptions = [...new Set(ctx.upstreamFindings.flatMap((finding) => finding.assumptions))];

  if (questions.length === 0 && assumptions.length === 0) {
    return undefined;
  }

  const isVerifyFlag = (text: string) => text.startsWith(VERIFY_AGAINST_CURRENT_LAW);
  const parts: string[] = [];
  const flags = questions.filter((question) => isVerifyFlag(question.text));

  if (flags.length > 0) {
    parts.push(
      `**${VERIFY_AGAINST_CURRENT_LAW}**`,
      ...flags.map((question) => `- ${question.text}`),
      "",
    );
  }

  for (const severity of SEVERITY_ORDER) {
    const group = questions.filter(
      (question) => question.severity === severity && !isVerifyFlag(question.text),
    );

    if (group.length > 0) {
      parts.push(
        `**${severity[0]?.toUpperCase()}${severity.slice(1)} priority**`,
        ...group.map((question) => `- ${question.text} (${question.from})`),
        "",
      );
    }
  }

  if (assumptions.length > 0) {
    parts.push("**Assumptions**", ...assumptions.map((assumption) => `- ${assumption}`));
  }

  return parts.join("\n").trim();
}

function referencesLine(part: DraftPart, knownIds: ReadonlySet<string>): string | undefined {
  const findingIds = part.findingIds.filter((id) => knownIds.has(id));
  const pieces = [
    findingIds.length > 0 ? `findings ${findingIds.join(", ")}` : undefined,
    part.scheduleRefs.length > 0 ? part.scheduleRefs.join(", ") : undefined,
  ].filter(Boolean);

  return pieces.length > 0 ? `_Relies on: ${pieces.join("; ")}._` : undefined;
}

export function draftMarkdown(draft: ResponseDraft, knownIds: ReadonlySet<string>): string {
  const parts: string[] = [`_${TAX_NOTICE_GUARDRAIL}_`, "", `**Subject:** ${draft.subject}`];

  if (draft.salutation) {
    parts.push("", draft.salutation);
  }

  draft.parts.forEach((part, index) => {
    const references = referencesLine(part, knownIds);

    parts.push("", `**${index + 1}. ${part.title}**`, part.content.trim());

    if (references) {
      parts.push(references);
    }
  });

  if (draft.closing) {
    parts.push("", draft.closing);
  }

  return parts.join("\n");
}

function draftPointFinding(part: DraftPart, upstream: readonly Finding[]): AgentFindingInput {
  const referenced = upstream.filter((finding) => part.findingIds.includes(finding.id));
  const evidence = referenced
    .flatMap((finding) => finding.evidence)
    .slice(0, MAX_EVIDENCE_PER_POINT)
    .map((item) => ({ evidenceId: item.id, description: item.description }));
  const references = [
    ...referenced.map((finding) => `${finding.id}: ${finding.summary}`),
    ...part.scheduleRefs,
  ];

  return {
    summary: `Response point: ${part.title}`,
    ...(references.length > 0 ? { detail: `Relies on:\n- ${references.join("\n- ")}` } : {}),
    severity: "info",
    confidence: referenced.length > 0 ? "medium" : "low",
    evidence,
  };
}

export function responseTaskOutput(
  result: AgentResult<ResponsePreparationOutput>,
  ctx: TaskExecutionContext,
  reconciliation: TaxReconciliation | undefined,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);
  const { draft } = result.output;
  const knownIds = new Set(ctx.upstreamFindings.map((finding) => finding.id));
  const findings: AgentFindingInput[] = [];
  const sections: TaskSectionDraft[] = [];
  const openQuestions: OpenQuestionDraft[] = [];

  if (draft) {
    for (const part of draft.parts) {
      findings.push(draftPointFinding(part, ctx.upstreamFindings));
    }

    sections.push({
      title: RESPONSE_DRAFT_SECTION_TITLE,
      kind: "text",
      content: draftMarkdown(draft, knownIds),
      findingIndexes: draft.parts.map((_part, index) => index),
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
  } else {
    sections.push(...(base.sections ?? []));
  }

  const draftText = [
    ...(draft ? draft.parts.map((part) => part.content) : []),
    draft?.subject,
    draft?.closing,
    ...(base.sections ?? []).map((section) => section.content),
  ]
    .filter(Boolean)
    .join("\n");

  for (const claim of findFilingClaims(draftText)) {
    openQuestions.push({
      text: `The draft says "${claim}". Nothing has been filed or submitted by this platform; correct the wording before use.`,
      severity: "high",
    });
  }

  findings.push(...base.findings);

  if (reconciliation && hasReconciliationData(reconciliation)) {
    const schedules = buildSchedules(reconciliation, noticeFigures(ctx));
    const index = findings.length;

    findings.push(schedules.finding);
    sections.push(
      ...schedules.sections.map((section) => ({ ...section, findingIndexes: [index] })),
    );
  }

  const allQuestions = [...openQuestions, ...(base.openQuestions ?? [])];
  const questionsText = openQuestionsMarkdown(ctx, allQuestions);

  if (questionsText || draft) {
    sections.push({
      title: OPEN_QUESTIONS_SECTION_TITLE,
      kind: "text",
      content: questionsText ?? "No open questions were raised.",
      findingIndexes: [],
    });
  }

  return {
    ...base,
    findings,
    openQuestions: allQuestions,
    sections,
    deliverables: [responsePackSpec()],
  };
}

export interface ResponsePreparationHandlerOptions extends ReconcileOptions {
  agent?: ResponsePreparationAgent;
}

/** Drafts the response from prior findings and attaches deterministic schedules. Never files anything. */
export function createResponsePreparationTaskHandler(
  options: ResponsePreparationHandlerOptions = {},
): TaskHandler {
  const agent = options.agent ?? createResponsePreparationAgent();

  return createPreparedTaskHandler<CaseRecords, SpecialistInput, ResponsePreparationOutput>(agent, {
    prepareAsync(ctx) {
      return reconcileCaseAsync(ctx, options);
    },
    buildInput(ctx, prepared) {
      const hasData = hasReconciliationData(prepared.reconciliation);
      const figures = computedFigures(ctx, prepared.reconciliation);
      const context: Record<string, unknown> = {
        guardrail: TAX_NOTICE_GUARDRAIL,
        ...(figures.length > 0 ? { computedFigures: figures } : {}),
        ...(hasData
          ? {
              schedules: [
                { ref: SCHEDULE_A, title: "TDS reconciliation by deductor and period" },
                { ref: SCHEDULE_B, title: "Computation of the TDS difference" },
              ],
            }
          : {}),
      };
      const input = buildSpecialistInput(ctx, context);
      const recordDocumentIds = taxRecordDocumentIds(prepared.records);

      return {
        ...input,
        documents: input.documents.filter(
          (slice) => !(slice.kind === "table" && recordDocumentIds.has(slice.documentId)),
        ),
      };
    },
    toTaskOutput(result, ctx, prepared) {
      return responseTaskOutput(result, ctx, prepared.reconciliation);
    },
  });
}
