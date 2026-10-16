import type {
  AgentRole,
  Citation,
  ConfidenceLevel,
  DeliverableSectionInput,
  DocumentMetadata,
  Evidence,
  EvidenceLocation,
  ExtractedDocument,
  Finding,
  ModelTier,
  Task,
} from "@evianta/core";

import {
  agentFindingSchema,
  openQuestionDraftSchema,
  PRIMARY_DELIVERABLE_KEY,
  sectionDraftSchema,
  type EvidenceReference,
  type OpenQuestionDraft,
} from "./findings.js";
import type { TaskOutput } from "./handlers.js";

export interface RecordContext {
  caseId: string;
  task: Task;
  documentsById: ReadonlyMap<string, DocumentMetadata>;
  extractionsById: ReadonlyMap<string, ExtractedDocument | undefined>;
  newId: () => string;
}

export interface DroppedEvidence {
  reference: EvidenceReference;
  reason: string;
}

export interface PlannedSection extends DeliverableSectionInput {
  deliverableKey: string;
  findingIds: string[];
  evidenceIds: string[];
}

export interface TaskRecord {
  findings: Finding[];
  evidence: Evidence[];
  sections: PlannedSection[];
  dropped: DroppedEvidence[];
}

export function confidenceFromScore(score: number | undefined): ConfidenceLevel {
  if (score === undefined) {
    return "unassessed";
  }

  if (score >= 0.85) {
    return "high";
  }

  return score >= 0.6 ? "medium" : "low";
}

function locationOf(reference: EvidenceReference): EvidenceLocation | undefined {
  const location: EvidenceLocation = {};

  if (reference.page !== undefined) {
    location.page = reference.page;
  }

  if (reference.sheet) {
    location.sheet = reference.sheet;
  }

  if (reference.cellRange) {
    location.cellRange = reference.cellRange;
  }

  if (reference.rowStart !== undefined) {
    const end = Math.max(reference.rowStart, reference.rowEnd ?? reference.rowStart);

    location.rowRange = { start: reference.rowStart, end };
  }

  if (reference.textQuote?.trim()) {
    location.textQuote = reference.textQuote.trim();
  }

  return Object.keys(location).length > 0 ? location : undefined;
}

function locationLabel(location: EvidenceLocation | undefined): string {
  if (!location) {
    return "";
  }

  if (location.page !== undefined) {
    return ` p.${location.page}`;
  }

  if (location.sheet && location.cellRange) {
    return ` ${location.sheet}!${location.cellRange}`;
  }

  if (location.rowRange) {
    const { start, end } = location.rowRange;

    return start === end ? ` row ${start}` : ` rows ${start}-${end}`;
  }

  return location.sheet ? ` ${location.sheet}` : "";
}

function documentConfidence(
  extraction: ExtractedDocument | undefined,
  page: number | undefined,
): ConfidenceLevel {
  if (!extraction) {
    return "unassessed";
  }

  const pageScore =
    page === undefined
      ? undefined
      : extraction.pages.find((item) => item.index === page)?.confidence;

  return confidenceFromScore(pageScore ?? extraction.confidence);
}

export function toEvidence(
  reference: EvidenceReference,
  citations: readonly Citation[],
  ctx: RecordContext,
): Evidence | DroppedEvidence {
  const location = locationOf(reference);

  if (reference.documentId) {
    const metadata = ctx.documentsById.get(reference.documentId);

    if (!metadata) {
      return { reference, reason: `Unknown document "${reference.documentId}".` };
    }

    const extraction = ctx.extractionsById.get(metadata.id);

    return {
      id: ctx.newId(),
      sourceRef: `${metadata.name}${locationLabel(location)}`,
      description: reference.description,
      ...(location?.textQuote ? { excerpt: location.textQuote } : {}),
      documentId: metadata.id,
      ...(location ? { location } : {}),
      confidence: reference.confidence ?? documentConfidence(extraction, location?.page),
    };
  }

  if (reference.url) {
    const citation = citations.find((item) => item.url === reference.url);

    if (!citation) {
      return { reference, reason: `URL "${reference.url}" is not among the grounding citations.` };
    }

    const excerpt = location?.textQuote ?? (citation.snippet || undefined);

    return {
      id: ctx.newId(),
      sourceRef: citation.url,
      description: reference.description || citation.title,
      ...(excerpt ? { excerpt } : {}),
      ...(location ? { location } : {}),
      confidence: reference.confidence ?? "medium",
    };
  }

  return { reference, reason: "Evidence reference has neither a documentId nor a url." };
}

function isDropped(value: Evidence | DroppedEvidence): value is DroppedEvidence {
  return "reason" in value;
}

function toOpenQuestions(drafts: readonly OpenQuestionDraft[], newId: () => string) {
  return drafts.map((draft) => {
    const parsed = openQuestionDraftSchema.parse(draft);

    return { id: newId(), text: parsed.text, severity: parsed.severity, status: "open" as const };
  });
}

export function renderFindingsMarkdown(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return "No findings were recorded.";
  }

  return findings
    .map((finding) => {
      const lines = [`- ${finding.summary}`];

      if (finding.detail) {
        lines.push(`  ${finding.detail.replace(/\n/g, "\n  ")}`);
      }

      for (const question of finding.openQuestions) {
        lines.push(`  - Open question (${question.severity}): ${question.text}`);
      }

      return lines.join("\n");
    })
    .join("\n");
}

export function sectionIdFor(taskId: string, index: number): string {
  return `${taskId}-section-${index + 1}`;
}

/** Turns a handler's output into persisted-shape findings, evidence, and deliverable sections. */
export function buildTaskRecord(
  output: TaskOutput,
  ctx: RecordContext,
  role: AgentRole,
  modelTier: ModelTier | undefined,
): TaskRecord {
  const citations = output.citations ?? [];
  const evidence: Evidence[] = [];
  const dropped: DroppedEvidence[] = [];
  const findings: Finding[] = output.findings.map((draft) => {
    const parsed = agentFindingSchema.parse(draft);
    const findingEvidence: Evidence[] = [];

    for (const reference of parsed.evidence) {
      const result = toEvidence(reference, citations, ctx);

      if (isDropped(result)) {
        dropped.push(result);
        continue;
      }

      findingEvidence.push(result);
    }

    evidence.push(...findingEvidence);

    return {
      id: ctx.newId(),
      taskId: ctx.task.id,
      summary: parsed.summary,
      ...(parsed.detail ? { detail: parsed.detail } : {}),
      severity: parsed.severity,
      confidence: parsed.confidence,
      evidence: findingEvidence,
      assumptions: parsed.assumptions,
      openQuestions: toOpenQuestions(parsed.openQuestions, ctx.newId),
      ...(parsed.figures ? { figures: parsed.figures } : {}),
      ...(parsed.dates ? { dates: parsed.dates } : {}),
    };
  });
  const agentFindingCount = findings.length;
  const taskQuestions = output.openQuestions ?? [];

  if (taskQuestions.length > 0) {
    findings.push({
      id: ctx.newId(),
      taskId: ctx.task.id,
      summary: `Open questions from "${ctx.task.title}"`,
      severity: "info",
      confidence: "unassessed",
      evidence: [],
      assumptions: [],
      openQuestions: toOpenQuestions(taskQuestions, ctx.newId),
    });
  }

  const drafts =
    output.sections && output.sections.length > 0
      ? output.sections
      : [
          {
            title: ctx.task.title,
            kind: "text" as const,
            content: renderFindingsMarkdown(findings),
          },
        ];
  const sections = drafts.map((draft, index): PlannedSection => {
    const parsed = sectionDraftSchema.parse(draft);
    const deliverableKey =
      "deliverableKey" in draft && typeof draft.deliverableKey === "string"
        ? draft.deliverableKey
        : PRIMARY_DELIVERABLE_KEY;
    const referenced = parsed.findingIndexes
      ? parsed.findingIndexes
          .filter((findingIndex) => findingIndex < agentFindingCount)
          .map((findingIndex) => findings[findingIndex] as Finding)
      : findings;
    const findingIds = [...new Set(referenced.map((finding) => finding.id))];
    const evidenceIds = [
      ...new Set(referenced.flatMap((finding) => finding.evidence.map((item) => item.id))),
    ];

    return {
      id: sectionIdFor(ctx.task.id, index),
      title: parsed.title,
      kind: parsed.kind,
      content: parsed.content,
      producedByRole: role,
      ...(modelTier ? { modelTier } : {}),
      findingIds,
      evidenceIds,
      deliverableKey,
    };
  });

  return { findings, evidence, sections, dropped };
}
