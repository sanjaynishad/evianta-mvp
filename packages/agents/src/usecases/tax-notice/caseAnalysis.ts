import { figureComponentSchema, findingSeveritySchema, type ConfidenceLevel } from "@evianta/core";
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
  formatAmount,
  markdownTable,
  taxNoticePackSpec,
  TAX_DATE_KEYS,
  TAX_FIGURE_KEYS,
} from "./constants.js";
import {
  createPreparedTaskHandler,
  loadCaseDocumentsAsync,
  pagesToVerify,
  resolveTaskAgent,
  type ReviewPage,
} from "./context.js";
import { readTaxRecords, taxRecordDocumentIds } from "./records.js";
import { sliceDocuments, type DocumentSlice } from "../../slices.js";

export const noticeSourceSchema = z.object({
  documentId: z.string(),
  page: z.number().int().positive().optional(),
  quote: z.string().optional(),
});

export type NoticeSource = z.infer<typeof noticeSourceSchema>;

export const noticeAnalysisSchema = z.object({
  noticeType: z.string().min(1),
  noticeTypeSource: noticeSourceSchema.optional(),
  referenceNumber: z.string().optional(),
  referenceNumberSource: noticeSourceSchema.optional(),
  assessmentYear: z.string().optional(),
  assessmentYearSource: noticeSourceSchema.optional(),
  sectionsCited: z
    .array(
      z.object({
        section: z.string().min(1),
        context: z.string().optional(),
        source: noticeSourceSchema.optional(),
      }),
    )
    .default([]),
  dates: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string(),
        date: z.string(),
        source: noticeSourceSchema.optional(),
      }),
    )
    .default([]),
  demandedFigures: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string(),
        amount: z.number(),
        components: z.array(figureComponentSchema).optional(),
        source: noticeSourceSchema.optional(),
      }),
    )
    .default([]),
  issues: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string(),
        severity: findingSeveritySchema.default("high"),
        sections: z.array(z.string()).default([]),
        source: noticeSourceSchema.optional(),
      }),
    )
    .default([]),
  requestedInformation: z
    .array(z.object({ item: z.string().min(1), source: noticeSourceSchema.optional() }))
    .default([]),
});

export type NoticeAnalysis = z.infer<typeof noticeAnalysisSchema>;

export const caseAnalysisOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  notice: noticeAnalysisSchema.optional(),
});

export type CaseAnalysisOutput = z.infer<typeof caseAnalysisOutputSchema>;

export type CaseAnalysisAgent = Agent<SpecialistInput, CaseAnalysisOutput>;

export const CASE_ANALYSIS_SYSTEM_PROMPT = [
  "You are the case analyst preparing an income-tax notice response for a Chartered Accountant to review.",
  "Read the notice pages in documents and fill notice: the notice type, reference number (DIN), assessment year, every section of the Income-tax Act it cites, its dates, the figures it states or demands, each issue it raises, and the information it asks for.",
  "Every item needs a source with the documentId, the 1-based page, and a short verbatim quote from that page, including noticeTypeSource, referenceNumberSource, and assessmentYearSource. Never invent a figure, date, or section; leave it out if it is not in the text.",
  `Dates are ISO yyyy-mm-dd. Use the key "${TAX_DATE_KEYS.issueDate}" for the date of issue and "${TAX_DATE_KEYS.responseDueDate}" for the response due date.`,
  `Figures are plain numbers in rupees. Use these keys when they apply: "${TAX_FIGURE_KEYS.demandTotal}" (total demand, with its components), "${TAX_FIGURE_KEYS.demandTax}", "${TAX_FIGURE_KEYS.demandInterest}", "${TAX_FIGURE_KEYS.tdsClaimedInReturn}" (TDS claimed in the return), "${TAX_FIGURE_KEYS.tdsPerTaxCredit}" (TDS allowed as per 26AS), "${TAX_FIGURE_KEYS.tdsDifference}" (TDS credit disallowed). Otherwise use "notice-" plus a short slug.`,
  "context.lowConfidencePages lists pages read by OCR or handwriting with low confidence; anything taken from them must be flagged in openQuestions for verification against the original.",
  "Use findings only for observations that do not fit notice. Do not interpret the law or decide the outcome; that is for the professional.",
].join("\n");

export function createCaseAnalysisAgent(): CaseAnalysisAgent {
  const { profile } = SPECIALIST_DEFINITIONS["case-analysis"];

  return defineAgent<SpecialistInput, CaseAnalysisOutput>({
    role: "case-analysis",
    modelTier: profile.modelTier,
    systemPrompt: CASE_ANALYSIS_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: caseAnalysisOutputSchema,
    grounding: false,
    maxOutputTokens: 4096,
    profile,
  });
}

interface CaseAnalysisPrepared {
  documents: DocumentSlice[];
  lowConfidencePages: ReviewPage[];
}

function isDueDate(label: string): boolean {
  return /\b(due|reply|respond|response|submit|compliance)\b/i.test(label);
}

function isIssueDate(label: string): boolean {
  return /\b(issue|issued|dated|date of (the )?(notice|intimation|order))\b/i.test(label);
}

export function canonicalDateKey(entry: { key: string; label: string }): string {
  if ((Object.values(TAX_DATE_KEYS) as string[]).includes(entry.key)) {
    return entry.key;
  }

  const text = `${entry.key} ${entry.label}`.replace(/-/g, " ");

  if (isDueDate(text)) {
    return TAX_DATE_KEYS.responseDueDate;
  }

  return isIssueDate(text) ? TAX_DATE_KEYS.issueDate : entry.key;
}

function sourceEvidence(
  source: NoticeSource | undefined,
  description: string,
): EvidenceReference[] {
  if (!source || !isTraceable(source)) {
    return [];
  }

  return [
    {
      documentId: source.documentId,
      description,
      ...(source.page !== undefined ? { page: source.page } : {}),
      ...(source.quote?.trim() ? { textQuote: source.quote.trim() } : {}),
    },
  ];
}

function dedupeEvidence(references: readonly EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.documentId}|${reference.page ?? ""}|${reference.textQuote ?? ""}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function pageLabel(source: NoticeSource | undefined): string {
  return source?.page !== undefined ? ` (p.${source.page})` : "";
}

/** A source names the document, the page, and a verbatim quote, so a reviewer can find it. */
export function isTraceable(source: NoticeSource | undefined): source is NoticeSource {
  return Boolean(source?.documentId && source.page !== undefined && source.quote?.trim());
}

/** Low when a source is a low-confidence page; medium when any item cannot be traced. */
function confidenceFor(
  sources: ReadonlyArray<NoticeSource | undefined>,
  lowConfidencePages: readonly ReviewPage[],
): ConfidenceLevel {
  const usesLowConfidencePage = sources.some(
    (source) =>
      source !== undefined &&
      lowConfidencePages.some(
        (page) => page.documentId === source.documentId && page.page === source.page,
      ),
  );

  if (usesLowConfidencePage) {
    return "low";
  }

  return sources.every(isTraceable) ? "high" : "medium";
}

interface ExtractedItem {
  label: string;
  source?: NoticeSource;
  /** Dates and amounts are what a response turns on, so untraced ones are high severity. */
  critical: boolean;
}

function untracedItemsQuestion(items: readonly ExtractedItem[]): OpenQuestionDraft | undefined {
  const untraced = items.filter((item) => !isTraceable(item.source));

  if (untraced.length === 0) {
    return undefined;
  }

  return {
    text: `These items could not be traced to a page and quote of the notice: ${untraced.map((item) => item.label).join("; ")}. Verify them against the original before relying on them.`,
    severity: untraced.some((item) => item.critical) ? "high" : "medium",
  };
}

export function noticeFindings(
  notice: NoticeAnalysis,
  lowConfidencePages: readonly ReviewPage[],
): { findings: AgentFindingInput[]; openQuestions: OpenQuestionDraft[] } {
  const findings: AgentFindingInput[] = [];
  const openQuestions: OpenQuestionDraft[] = [];
  const dates = notice.dates.map((entry) => ({ ...entry, key: canonicalDateKey(entry) }));
  const identity = [
    { label: "Notice type", source: notice.noticeTypeSource },
    ...(notice.referenceNumber
      ? [{ label: "Reference number", source: notice.referenceNumberSource }]
      : []),
    ...(notice.assessmentYear
      ? [{ label: "Assessment year", source: notice.assessmentYearSource }]
      : []),
  ];
  const overviewSources = [
    ...identity.map((entry) => entry.source),
    ...dates.map((entry) => entry.source),
    ...notice.sectionsCited.map((entry) => entry.source),
  ];
  const overviewDetail = [
    notice.referenceNumber ? `Reference: ${notice.referenceNumber}` : undefined,
    notice.assessmentYear ? `Assessment year: ${notice.assessmentYear}` : undefined,
    notice.sectionsCited.length > 0
      ? `Sections cited: ${notice.sectionsCited.map((entry) => entry.section).join(", ")}`
      : undefined,
    ...dates.map((entry) => `${entry.label}: ${entry.date}`),
  ]
    .filter(Boolean)
    .join("\n");

  findings.push({
    summary: [
      notice.noticeType,
      notice.assessmentYear ? `for assessment year ${notice.assessmentYear}` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    ...(overviewDetail ? { detail: overviewDetail } : {}),
    severity: "medium",
    confidence: confidenceFor(overviewSources, lowConfidencePages),
    evidence: dedupeEvidence(
      [
        ...identity,
        ...dates,
        ...notice.sectionsCited.map((entry) => ({ ...entry, label: entry.section })),
      ].flatMap((entry) => sourceEvidence(entry.source, entry.label)),
    ),
    ...(dates.length > 0
      ? { dates: dates.map(({ key, label, date }) => ({ key, label, date })) }
      : {}),
  });

  const untraced = untracedItemsQuestion([
    ...identity.map((entry) => ({ ...entry, critical: false })),
    ...dates.map((entry) => ({
      label: `${entry.label} (${entry.date})`,
      source: entry.source,
      critical: true,
    })),
    ...notice.sectionsCited.map((entry) => ({
      label: `section ${entry.section}`,
      source: entry.source,
      critical: false,
    })),
    ...notice.demandedFigures.map((figure) => ({
      label: `${figure.label} (Rs ${formatAmount(figure.amount)})`,
      source: figure.source,
      critical: true,
    })),
    ...notice.issues.map((issue) => ({
      label: issue.title,
      source: issue.source,
      critical: false,
    })),
    ...notice.requestedInformation.map((entry) => ({
      label: entry.item,
      source: entry.source,
      critical: false,
    })),
  ]);

  if (untraced) {
    openQuestions.push(untraced);
  }

  if (!dates.some((entry) => entry.key === TAX_DATE_KEYS.responseDueDate)) {
    openQuestions.push({
      text: "No response due date could be read from the notice. Confirm the deadline before relying on this pack.",
      severity: "high",
    });
  }

  for (const issue of notice.issues) {
    const sections = issue.sections.length > 0 ? `\nSections: ${issue.sections.join(", ")}` : "";

    findings.push({
      summary: issue.title,
      detail: `${issue.description}${sections}`,
      severity: issue.severity,
      confidence: isTraceable(issue.source)
        ? confidenceFor([issue.source], lowConfidencePages)
        : "low",
      evidence: sourceEvidence(issue.source, issue.title),
    });
  }

  const tracedFigures = notice.demandedFigures.filter((figure) => isTraceable(figure.source));
  const untracedFigures = notice.demandedFigures.filter((figure) => !isTraceable(figure.source));
  const toFigure = (figure: NoticeAnalysis["demandedFigures"][number]) => ({
    key: figure.key,
    label: figure.label,
    value: figure.amount,
    unit: "INR",
    ...(figure.components && figure.components.length > 0 ? { components: figure.components } : {}),
  });

  // Untraced amounts get their own finding with no evidence, so review flags them instead of a
  // traced amount lending them its source.
  if (untracedFigures.length > 0) {
    findings.push({
      summary: "Figures stated in the notice that could not be traced to a page",
      detail: untracedFigures
        .map((figure) => `${figure.label}: Rs ${formatAmount(figure.amount)}`)
        .join("\n"),
      severity: "high",
      confidence: "low",
      evidence: [],
      figures: untracedFigures.map(toFigure),
    });
  }

  if (tracedFigures.length > 0) {
    findings.push({
      summary: "Figures stated in the notice",
      detail: tracedFigures
        .map(
          (figure) =>
            `${figure.label}: Rs ${formatAmount(figure.amount)}${pageLabel(figure.source)}`,
        )
        .join("\n"),
      severity: "high",
      confidence: confidenceFor(
        tracedFigures.map((figure) => figure.source),
        lowConfidencePages,
      ),
      evidence: dedupeEvidence(
        tracedFigures.flatMap((figure) => sourceEvidence(figure.source, figure.label)),
      ),
      figures: tracedFigures.map(toFigure),
    });
  }

  if (notice.requestedInformation.length > 0) {
    findings.push({
      summary: "Information requested by the notice",
      detail: notice.requestedInformation
        .map((entry) => `- ${entry.item}${pageLabel(entry.source)}`)
        .join("\n"),
      severity: "medium",
      confidence: confidenceFor(
        notice.requestedInformation.map((entry) => entry.source),
        lowConfidencePages,
      ),
      evidence: dedupeEvidence(
        notice.requestedInformation.flatMap((entry) => sourceEvidence(entry.source, entry.item)),
      ),
    });
  }

  return { findings, openQuestions };
}

export function lowConfidenceFinding(pages: readonly ReviewPage[]): AgentFindingInput {
  return {
    summary: `${pages.length} page(s) were transcribed with low confidence and need verification`,
    detail: pages
      .map(
        (page) =>
          `${page.documentName} p.${page.page}: ${page.method} at ${Math.round(page.confidence * 100)}% confidence`,
      )
      .join("\n"),
    severity: "medium",
    confidence: "low",
    evidence: pages.map((page) => ({
      documentId: page.documentId,
      page: page.page,
      description: `Low-confidence ${page.method} transcription`,
    })),
    openQuestions: pages.map((page) => ({
      text: `${page.documentName} page ${page.page} was read by ${page.method === "handwriting" ? "handwriting recognition" : "OCR"} at ${Math.round(page.confidence * 100)}% confidence. Verify any figure, date, or section taken from it against the original.`,
      severity: "high" as const,
    })),
  };
}

function noticeSectionMarkdown(notice: NoticeAnalysis, pages: readonly ReviewPage[]): string {
  const parts: string[] = [
    `**Notice:** ${notice.noticeType}`,
    ...(notice.assessmentYear ? [`**Assessment year:** ${notice.assessmentYear}`] : []),
    ...(notice.referenceNumber ? [`**Reference:** ${notice.referenceNumber}`] : []),
  ];

  if (notice.dates.length > 0) {
    parts.push(
      "",
      "**Key dates**",
      ...notice.dates.map((entry) => `- ${entry.label}: ${entry.date}${pageLabel(entry.source)}`),
    );
  }

  if (notice.sectionsCited.length > 0) {
    parts.push(
      "",
      "**Sections cited**",
      ...notice.sectionsCited.map(
        (entry) =>
          `- ${entry.section}${entry.context ? `: ${entry.context}` : ""}${pageLabel(entry.source)}`,
      ),
    );
  }

  if (notice.issues.length > 0) {
    parts.push(
      "",
      "**Issues raised**",
      ...notice.issues.map(
        (issue, index) =>
          `${index + 1}. ${issue.title}: ${issue.description}${pageLabel(issue.source)}`,
      ),
    );
  }

  if (notice.demandedFigures.length > 0) {
    parts.push(
      "",
      "**Figures stated in the notice**",
      "",
      markdownTable(
        ["Item", "Amount (Rs)", "Source"],
        notice.demandedFigures.map((figure) => [
          figure.label,
          formatAmount(figure.amount),
          figure.source?.page !== undefined ? `p.${figure.source.page}` : "-",
        ]),
      ),
    );
  }

  if (notice.requestedInformation.length > 0) {
    parts.push(
      "",
      "**Information requested**",
      ...notice.requestedInformation.map((entry) => `- ${entry.item}${pageLabel(entry.source)}`),
    );
  }

  if (pages.length > 0) {
    parts.push(
      "",
      "**Transcription to verify**",
      ...pages.map(
        (page) =>
          `- ${page.documentName} p.${page.page}: ${page.method}, ${Math.round(page.confidence * 100)}% confidence`,
      ),
    );
  }

  return parts.join("\n");
}

export function caseAnalysisTaskOutput(
  result: AgentResult<CaseAnalysisOutput>,
  lowConfidencePages: readonly ReviewPage[],
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);
  const { notice } = result.output;
  const structured = notice
    ? noticeFindings(notice, lowConfidencePages)
    : { findings: [], openQuestions: [] };
  const findings = [...structured.findings, ...base.findings];

  if (lowConfidencePages.length > 0) {
    findings.push(lowConfidenceFinding(lowConfidencePages));
  }

  const sections: TaskSectionDraft[] = notice
    ? [
        {
          title: "Notice analysis",
          kind: "text",
          content: noticeSectionMarkdown(notice, lowConfidencePages),
          findingIndexes: findings.map((_finding, index) => index),
        },
      ]
    : (base.sections ?? []);

  return {
    ...base,
    findings,
    openQuestions: [...structured.openQuestions, ...(base.openQuestions ?? [])],
    sections,
    deliverables: [taxNoticePackSpec()],
  };
}

export interface CaseAnalysisHandlerOptions {
  agent?: CaseAnalysisAgent;
}

/** Notice extraction with page references; low-confidence OCR pages become verification flags. */
export function createCaseAnalysisTaskHandler(
  options: CaseAnalysisHandlerOptions = {},
): TaskHandler {
  return createPreparedTaskHandler<CaseAnalysisPrepared, SpecialistInput, CaseAnalysisOutput>(
    "case-analysis",
    (ctx) => resolveTaskAgent(ctx, "case-analysis", options.agent, createCaseAnalysisAgent),
    {
      async prepareAsync(ctx: TaskExecutionContext) {
        const documents = await loadCaseDocumentsAsync(ctx);
        const recordDocumentIds = taxRecordDocumentIds(readTaxRecords(documents));

        return {
          documents: sliceDocuments(
            documents.map((document) =>
              document.extraction && recordDocumentIds.has(document.metadata.id)
                ? { ...document, extraction: { ...document.extraction, tables: [] } }
                : document,
            ),
            ctx.documentSliceOptions,
          ),
          lowConfidencePages: pagesToVerify(
            documents.filter((document) => !recordDocumentIds.has(document.metadata.id)),
          ),
        };
      },
      buildInput(ctx, prepared) {
        const input = buildSpecialistInput(
          ctx,
          prepared.lowConfidencePages.length > 0
            ? { lowConfidencePages: prepared.lowConfidencePages }
            : undefined,
        );

        return {
          ...input,
          documents: prepared.documents,
        };
      },
      toTaskOutput(result, _ctx, prepared) {
        return caseAnalysisTaskOutput(
          { ...result, output: caseAnalysisOutputSchema.parse(result.output) },
          prepared.lowConfidencePages,
        );
      },
    },
  );
}
