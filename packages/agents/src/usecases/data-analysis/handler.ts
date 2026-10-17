import type { Cost } from "@evianta/ai";
import type {
  EvidenceLocation,
  FindingFigure,
  ModelTier,
  OpenQuestionSeverity,
  TokenUsage,
} from "@evianta/core";

import type { AgentResult } from "../../agent.js";
import type {
  AgentFindingInput,
  DeliverableSpec,
  EvidenceReference,
  OpenQuestionDraft,
} from "../../findings.js";
import {
  agentContextFor,
  buildSpecialistInput,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
  type TaskSectionDraft,
} from "../../handlers.js";
import { withBilledUsageAsync } from "../../errors.js";
import {
  createDataAnalystAgent,
  isDataAnalystAgent,
  type DataAnalystAgent,
  type DataAnalystOutput,
} from "./agent.js";
import {
  analyzeTable,
  DataAnalysisError,
  selectAnalysisSource,
  type DataAnalysis,
  type TabularSource,
} from "./analysis.js";
import { buildDashboardCharts } from "./charts.js";
import { cellText } from "./cells.js";
import { describeLocation, MAX_LOCATIONS_PER_ITEM, rowLocations, rowRuns } from "./evidence.js";
import { formatMetricValue } from "./format.js";
import { allowedNarrativeValues, renderNarrative, type NarrativeIssue } from "./narrative.js";
import { DATA_QUALITY_KIND_LABELS } from "./quality.js";
import { ANOMALY_SCORE_THRESHOLD } from "./anomalies.js";
import {
  anomalyList,
  anomalyScreeningNote,
  bulletList,
  dataQualityTable,
  keyMetricsTable,
  monthlyTable,
} from "./report.js";

export const DATA_ANALYST_DASHBOARD_KEY = "dashboard";
export const DATA_ANALYST_DASHBOARD_TITLE = "Dashboard";
export const DEFAULT_SAMPLE_ROWS = 5;
export const MAX_CONTEXT_PERIODS = 24;
export const MAX_CONTEXT_TOP_SEGMENTS = 5;
export const MAX_CONTEXT_BOTTOM_SEGMENTS = 2;
export const MAX_EVIDENCE_PER_FINDING = 6;
export const MAX_FIGURES_PER_FINDING = 30;
export const MAX_NARRATIVE_QUESTIONS = 10;
const MAX_SAMPLE_CELL_CHARS = 80;

export const DATA_ANALYST_REPORT_SECTIONS = [
  "Summary",
  "Key metrics",
  "Trends",
  "Anomalies",
  "Data quality",
  "Assumptions and open questions",
] as const;

/** Every table in the case's cached extractions, in document order. */
export async function loadTabularSourcesAsync(
  ctx: Pick<TaskExecutionContext, "documentMetadata" | "loadExtractionAsync">,
): Promise<TabularSource[]> {
  const sources: TabularSource[] = [];

  for (const metadata of ctx.documentMetadata) {
    const extraction = await ctx.loadExtractionAsync(metadata.id);

    for (const table of extraction?.tables ?? []) {
      if (table.rows.length > 0) {
        sources.push({ documentId: metadata.id, documentName: metadata.name, table });
      }
    }
  }

  return sources;
}

/** Aggregates and a few sample rows for the model; never the full dataset. */
export function buildAnalystContext(
  analysis: DataAnalysis,
  maxSampleRows = DEFAULT_SAMPLE_ROWS,
): Record<string, unknown> {
  const referenced = new Set<string>(analysis.headlineMetricIds);
  const reference = (id: string | undefined) => {
    if (id) {
      referenced.add(id);
    }

    return id;
  };

  const { table } = analysis.source;
  const periods = analysis.periods.slice(-MAX_CONTEXT_PERIODS).map((period) => ({
    period: period.period,
    rows: period.rows.length,
    totalMetricId: reference(period.totalMetricId),
    ...(period.changeMetricId ? { changeMetricId: reference(period.changeMetricId) } : {}),
  }));
  const segments = analysis.segments.map((breakdown) => {
    const shown =
      breakdown.segments.length <= MAX_CONTEXT_TOP_SEGMENTS + MAX_CONTEXT_BOTTOM_SEGMENTS
        ? breakdown.segments
        : [
            ...breakdown.segments.slice(0, MAX_CONTEXT_TOP_SEGMENTS),
            ...breakdown.segments.slice(-MAX_CONTEXT_BOTTOM_SEGMENTS),
          ];

    return {
      column: breakdown.column,
      segmentCount: breakdown.segments.length,
      ...(breakdown.top ? { top: breakdown.top.label } : {}),
      ...(breakdown.bottom ? { bottom: breakdown.bottom.label } : {}),
      segments: shown.map((segment) => ({
        label: segment.label,
        ...(segment.unassigned ? { unassigned: true } : {}),
        rows: segment.rows.length,
        totalMetricId: reference(segment.totalMetricId),
        ...(segment.shareMetricId ? { shareMetricId: reference(segment.shareMetricId) } : {}),
      })),
    };
  });
  const anomalies = analysis.anomalies.map((anomaly) => ({
    id: anomaly.id,
    period: anomaly.period,
    direction: anomaly.direction,
    valueMetricId: reference(anomaly.valueMetricId),
    expectedMetricId: reference(anomaly.expectedMetricId),
    ...(anomaly.deviationMetricId
      ? { deviationMetricId: reference(anomaly.deviationMetricId) }
      : {}),
    scoreMetricId: reference(anomaly.scoreMetricId),
  }));
  const dataQuality = analysis.issues.map((issue) => ({
    id: issue.id,
    kind: issue.kind,
    severity: issue.severity,
    ...(issue.column ? { column: issue.column } : {}),
    message: issue.message,
    treatment: issue.treatment,
    rowsMetricId: reference(issue.rowsMetricId),
  }));
  const trend = analysis.trend
    ? {
        method: "Theil-Sen slope of monthly totals",
        slopeMetricId: reference(analysis.trend.slopeMetricId),
        ...(analysis.trend.growthMetricId
          ? { growthMetricId: reference(analysis.trend.growthMetricId) }
          : {}),
        ...(analysis.trend.averageChangeMetricId
          ? { averageChangeMetricId: reference(analysis.trend.averageChangeMetricId) }
          : {}),
      }
    : undefined;
  const sampleRows = analysis.analyzedRows
    .slice(0, Math.max(0, maxSampleRows))
    .map((row) =>
      Object.fromEntries(
        table.columns.map((column, index) => [
          column.name,
          cellText(table.rows[row]?.[index]).slice(0, MAX_SAMPLE_CELL_CHARS),
        ]),
      ),
    );

  return {
    dataset: {
      document: analysis.source.documentName,
      table: table.name,
      ...(table.sheet ? { sheet: table.sheet } : {}),
      ...(table.range ? { range: table.range } : {}),
      dataRows: analysis.rowCount,
      analyzedRows: analysis.analyzedRows.length,
      currency: analysis.currency ?? "not stated",
      columns: analysis.columns.map((column) => ({
        name: column.name,
        role: column.role,
        type: column.sourceType,
        missing: column.missing,
      })),
    },
    metrics: analysis.metrics
      .filter((metric) => referenced.has(metric.id))
      .map(({ id, label, value, unit }) => ({ id, label, value, unit })),
    periods,
    ...(trend ? { trend } : {}),
    segments,
    anomalyScreening: {
      ...analysis.anomalyScreening,
      threshold: ANOMALY_SCORE_THRESHOLD,
      note: anomalyScreeningNote(analysis),
    },
    anomalies,
    dataQuality,
    assumptions: analysis.assumptions,
    openQuestions: analysis.questions,
    sampleRows,
  };
}

function toReference(
  analysis: DataAnalysis,
  location: EvidenceLocation,
  description: string,
): EvidenceReference {
  return {
    documentId: analysis.source.documentId,
    description,
    ...(location.sheet ? { sheet: location.sheet } : {}),
    ...(location.cellRange ? { cellRange: location.cellRange } : {}),
    ...(location.rowRange
      ? { rowStart: location.rowRange.start, rowEnd: location.rowRange.end }
      : {}),
    confidence: "high",
  };
}

function uniqueReferences(references: readonly EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();

  return references
    .filter((reference) => {
      const key = `${reference.sheet ?? ""}!${reference.cellRange ?? ""}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    })
    .slice(0, MAX_EVIDENCE_PER_FINDING);
}

/** Evidence for every metric: the rows or columns its value was computed from. */
function metricEvidenceIndex(analysis: DataAnalysis): Map<string, EvidenceReference[]> {
  const { table } = analysis.source;
  const amountName = analysis.roles.amount.name;
  const index = new Map<string, EvidenceReference[]>();
  const amountColumn = toReference(
    analysis,
    analysis.locations.amount,
    `${amountName} column (${describeLocation(analysis.locations.amount)})`,
  );
  const dateColumn = analysis.locations.date
    ? toReference(
        analysis,
        analysis.locations.date,
        `${analysis.roles.date?.name ?? "Date"} column (${describeLocation(analysis.locations.date)})`,
      )
    : undefined;
  const rowsOf = (rows: readonly number[], description: string) =>
    rowLocations(table, rows, undefined, MAX_LOCATIONS_PER_ITEM).map((location) =>
      toReference(analysis, location, `${description} (${describeLocation(location)})`),
    );

  for (const metric of analysis.metrics) {
    index.set(metric.id, [amountColumn]);
  }

  if (analysis.locations.quantity && analysis.metricsById.has("total-quantity")) {
    index.set("total-quantity", [
      toReference(
        analysis,
        analysis.locations.quantity,
        `${analysis.roles.quantity?.name ?? "Quantity"} column (${describeLocation(analysis.locations.quantity)})`,
      ),
    ]);
  }

  if (dateColumn && analysis.metricsById.has("period-count")) {
    index.set("period-count", [dateColumn]);
  }

  const columns = [amountColumn, ...(dateColumn ? [dateColumn] : [])];

  analysis.periods.forEach((period, position) => {
    index.set(
      period.totalMetricId,
      period.rows.length > 0 ? rowsOf(period.rows, `Rows dated in ${period.period}`) : columns,
    );

    const previous = analysis.periods[position - 1];

    if (period.changeMetricId && previous) {
      // A month-over-month change rests on both months' rows.
      const rows = [...previous.rows, ...period.rows];

      index.set(
        period.changeMetricId,
        rows.length > 0
          ? rowsOf(rows, `Rows dated in ${previous.period} and ${period.period}`)
          : columns,
      );
    }
  });

  if (analysis.trend) {
    for (const id of [
      analysis.trend.slopeMetricId,
      analysis.trend.growthMetricId,
      analysis.trend.averageChangeMetricId,
    ]) {
      if (id) {
        index.set(id, columns);
      }
    }
  }

  for (const breakdown of analysis.segments) {
    const location = analysis.locations.categories.get(breakdown.columnIndex);
    const categoryColumn = location
      ? toReference(
          analysis,
          location,
          `${breakdown.column} column (${describeLocation(location)})`,
        )
      : undefined;

    for (const segment of breakdown.segments) {
      const references = [...(categoryColumn ? [categoryColumn] : []), amountColumn];

      index.set(segment.totalMetricId, references);

      if (segment.shareMetricId) {
        index.set(segment.shareMetricId, references);
      }
    }
  }

  for (const anomaly of analysis.anomalies) {
    // The expected value and score come from the whole monthly series, so the columns lead.
    const references = [...columns, ...rowsOf(anomaly.rows, `Rows dated in ${anomaly.period}`)];

    for (const id of [anomaly.expectedMetricId, anomaly.deviationMetricId, anomaly.scoreMetricId]) {
      if (id) {
        index.set(id, references);
      }
    }
  }

  for (const issue of analysis.issues) {
    index.set(issue.rowsMetricId, issueReferences(analysis, issue.id));
  }

  return index;
}

function issueReferences(analysis: DataAnalysis, issueId: string): EvidenceReference[] {
  const issue = analysis.issues.find((candidate) => candidate.id === issueId);

  if (!issue) {
    return [];
  }

  const label = `${DATA_QUALITY_KIND_LABELS[issue.kind]}${issue.column ? ` in ${issue.column}` : ""}`;

  return issue.locations.map((location) =>
    toReference(analysis, location, `${label} (${describeLocation(location)})`),
  );
}

function figureFor(analysis: DataAnalysis, id: string): FindingFigure | undefined {
  const metric = analysis.metricsById.get(id);

  if (!metric) {
    return undefined;
  }

  const unit =
    metric.unit === "percent"
      ? "%"
      : metric.unit === "currency"
        ? analysis.currency
        : metric.unit === "count"
          ? metric.countOf
          : undefined;

  return { key: metric.id, label: metric.label, value: metric.value, ...(unit ? { unit } : {}) };
}

function figuresFor(analysis: DataAnalysis, ids: readonly (string | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => id !== undefined))];

  return unique
    .map((id) => figureFor(analysis, id))
    .filter((figure): figure is FindingFigure => figure !== undefined)
    .slice(0, MAX_FIGURES_PER_FINDING);
}

function display(analysis: DataAnalysis, id: string | undefined): string {
  const metric = id ? analysis.metricsById.get(id) : undefined;

  return metric ? formatMetricValue(metric, analysis.currency) : "";
}

interface BuiltFindings {
  findings: AgentFindingInput[];
  overview: number;
  trend?: number;
  segments: Map<number, number>;
  anomalies: number[];
  issues: number[];
}

function deterministicFindings(
  analysis: DataAnalysis,
  evidence: ReadonlyMap<string, EvidenceReference[]>,
  modelAssumptions: readonly string[],
): BuiltFindings {
  const amountName = analysis.roles.amount.name;
  const findings: AgentFindingInput[] = [];
  const referencesFor = (ids: readonly (string | undefined)[]) =>
    uniqueReferences(ids.flatMap((id) => (id ? (evidence.get(id) ?? []) : [])));
  const push = (finding: AgentFindingInput) => findings.push(finding) - 1;
  const headline = analysis.headlineMetricIds;
  const overview = push({
    summary: `${display(analysis, "total-amount")} total ${amountName} across ${display(analysis, "rows-with-amount")} rows with a numeric ${amountName}.`,
    detail: headline
      .map((id) => analysis.metricsById.get(id))
      .filter((metric) => metric !== undefined)
      .map((metric) => `- ${metric.label}: ${formatMetricValue(metric, analysis.currency)}`)
      .join("\n"),
    severity: "info",
    confidence: "high",
    evidence: referencesFor(["total-amount", ...headline]),
    figures: figuresFor(analysis, headline),
    assumptions: [...analysis.assumptions, ...modelAssumptions],
    openQuestions: analysis.questions.map((question) => ({ ...question })),
  });
  let trend: number | undefined;

  if (analysis.periods.length >= 2) {
    const first = analysis.periods[0];
    const last = analysis.periods[analysis.periods.length - 1];
    const growth = analysis.trend?.growthMetricId;

    trend = push({
      summary: `Monthly ${amountName} moved from ${display(analysis, first?.totalMetricId)} in ${first?.period} to ${display(analysis, last?.totalMetricId)} in ${last?.period}${growth ? `, a change of ${display(analysis, growth)}` : ""}.`,
      detail: analysis.periods
        .map(
          (period) =>
            `- ${period.period}: ${display(analysis, period.totalMetricId)}${period.changeMetricId ? ` (${display(analysis, period.changeMetricId)} from the previous month)` : ""}`,
        )
        .join("\n"),
      severity: "info",
      confidence: "high",
      evidence: referencesFor([
        analysis.trend?.slopeMetricId ?? "total-amount",
        ...analysis.periods.map((period) => period.totalMetricId),
      ]),
      figures: figuresFor(analysis, [
        analysis.trend?.growthMetricId,
        analysis.trend?.averageChangeMetricId,
        analysis.trend?.slopeMetricId,
        ...analysis.periods.map((period) => period.totalMetricId),
      ]),
    });
  }

  const segments = new Map<number, number>();

  for (const breakdown of analysis.segments) {
    const { top, bottom } = breakdown;

    if (!top) {
      continue;
    }

    const unassigned = breakdown.segments.find((segment) => segment.unassigned);
    const parts = [
      `${breakdown.column} ${top.label} leads with ${display(analysis, top.totalMetricId)}${top.shareMetricId ? ` (${display(analysis, top.shareMetricId)} of the total)` : ""}`,
      ...(bottom
        ? [
            `${bottom.label} is lowest with ${display(analysis, bottom.totalMetricId)}${bottom.shareMetricId ? ` (${display(analysis, bottom.shareMetricId)})` : ""}`,
          ]
        : []),
    ];

    segments.set(
      breakdown.columnIndex,
      push({
        summary: `${parts.join("; ")}.`,
        detail: breakdown.segments
          .map(
            (segment) =>
              `- ${segment.label}: ${display(analysis, segment.totalMetricId)}${segment.shareMetricId ? ` (${display(analysis, segment.shareMetricId)})` : ""}`,
          )
          .join("\n"),
        severity: "info",
        confidence: "high",
        evidence: referencesFor([top.totalMetricId]),
        figures: figuresFor(analysis, [
          top.totalMetricId,
          top.shareMetricId,
          bottom?.totalMetricId,
          bottom?.shareMetricId,
          unassigned?.totalMetricId,
        ]),
        ...(unassigned
          ? { assumptions: [`Rows with no ${breakdown.column} are grouped as Unassigned.`] }
          : {}),
      }),
    );
  }

  const anomalies = analysis.anomalies.map((anomaly) =>
    push({
      summary: `${amountName} in ${anomaly.period} was ${display(analysis, anomaly.valueMetricId)}, ${anomaly.direction === "spike" ? "above" : "below"} the ${display(analysis, anomaly.expectedMetricId)} expected from the trend${anomaly.deviationMetricId ? ` (${display(analysis, anomaly.deviationMetricId)})` : ""}.`,
      detail: `Flagged with a robust z-score of ${display(analysis, anomaly.scoreMetricId)} against the Theil-Sen trend of monthly totals (threshold 3.5).`,
      severity: "medium",
      confidence: "high",
      evidence: referencesFor([anomaly.scoreMetricId]),
      figures: figuresFor(analysis, [
        anomaly.valueMetricId,
        anomaly.expectedMetricId,
        anomaly.deviationMetricId,
        anomaly.scoreMetricId,
      ]),
      openQuestions: [
        {
          text: `What explains the ${anomaly.direction} in ${anomaly.period}? Confirm whether it reflects real activity or a data issue.`,
          severity: "medium",
        },
      ],
    }),
  );
  const issues = analysis.issues.map((issue) =>
    push({
      summary: issue.message,
      detail: `Cells: ${issue.locations.map(describeLocation).join(", ")}${rowRuns(issue.rows).length > issue.locations.length ? " (first ranges shown)" : ""}. ${issue.treatment}`,
      severity: issue.severity,
      confidence: "high",
      evidence: uniqueReferences(issueReferences(analysis, issue.id)),
      figures: figuresFor(analysis, [issue.rowsMetricId]),
      assumptions: [issue.treatment],
      openQuestions: [{ text: issue.question, severity: issue.severity }],
    }),
  );

  return {
    findings,
    overview,
    ...(trend !== undefined ? { trend } : {}),
    segments,
    anomalies,
    issues,
  };
}

export interface ModelRun {
  usage: TokenUsage;
  cost: Cost;
  modelTier?: ModelTier;
}

const SEVERITY_ORDER: Record<OpenQuestionSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Maps the deterministic analysis and the model's interpretation to findings, a report, and a
 * dashboard. Numbers come only from the analysis; the narrative is checked against it.
 */
export function buildDataAnalystTaskOutput(
  analysis: DataAnalysis,
  output: DataAnalystOutput,
  run: ModelRun,
): TaskOutput {
  const evidence = metricEvidenceIndex(analysis);
  const allowed = allowedNarrativeValues(analysis.metrics);
  const narrativeIssues: NarrativeIssue[] = [];
  const render = (text: string, field: string) => {
    const rendered = renderNarrative(text, field, analysis.metricsById, {
      ...(analysis.currency ? { currency: analysis.currency } : {}),
      ...(analysis.currencyCode ? { currencyCode: analysis.currencyCode } : {}),
      allowed,
    });

    narrativeIssues.push(...rendered.issues);

    return rendered;
  };

  const summary = render(output.summary, "summary");
  const trends = render(output.trends, "trends");
  const anomalyNarrative = render(output.anomalies, "anomalies");
  const assumptions = output.assumptions.map(
    (text, index) => render(text, `assumption ${index + 1}`).text,
  );
  const built = deterministicFindings(analysis, evidence, assumptions);
  const { findings } = built;
  const anomalyIds = new Set(analysis.anomalies.map((anomaly) => anomaly.id));
  const issueIds = new Set(analysis.issues.map((issue) => issue.id));
  const insightIndexes: number[] = [];

  output.insights.forEach((insight, position) => {
    const field = `insight ${position + 1}`;
    const insightSummary = render(insight.summary, field);
    const insightDetail = insight.detail ? render(insight.detail, field) : undefined;
    const metricIds = [
      ...new Set([
        ...insight.metricIds,
        ...insightSummary.metricIds,
        ...(insightDetail?.metricIds ?? []),
      ]),
    ];
    const knownMetricIds = metricIds.filter((id) => analysis.metricsById.has(id));
    const unknown = [
      ...metricIds.filter((id) => !analysis.metricsById.has(id)),
      ...insight.anomalyIds.filter((id) => !anomalyIds.has(id)),
      ...insight.issueIds.filter((id) => !issueIds.has(id)),
    ];

    for (const id of unknown) {
      narrativeIssues.push({
        kind: "unknown-metric",
        field,
        token: id,
        message: `The ${field} cites "${id}", which is not a computed metric, anomaly, or data-quality issue.`,
      });
    }

    const knownAnomalies = analysis.anomalies.filter((anomaly) =>
      insight.anomalyIds.includes(anomaly.id),
    );
    const knownIssues = analysis.issues.filter((issue) => insight.issueIds.includes(issue.id));
    let references = uniqueReferences([
      ...knownMetricIds.flatMap((id) => evidence.get(id) ?? []),
      ...knownAnomalies.flatMap((anomaly) => evidence.get(anomaly.scoreMetricId) ?? []),
      ...knownIssues.flatMap((issue) => issueReferences(analysis, issue.id)),
    ]);
    const openQuestions: OpenQuestionDraft[] = insight.openQuestions.map((question) => ({
      text: render(question.text, field).text,
      severity: question.severity,
    }));
    const material = insight.severity === "high" || insight.severity === "medium";

    if (references.length === 0 && material) {
      references = evidence.get("total-amount") ?? [];
      openQuestions.push({
        text: `"${insightSummary.text}" does not cite a computed metric, anomaly, or data-quality issue; confirm it against the data.`,
        severity: "low",
      });
    }

    insightIndexes.push(
      findings.push({
        summary: insightSummary.text,
        ...(insightDetail ? { detail: insightDetail.text } : {}),
        severity: insight.severity,
        confidence: insight.confidence,
        evidence: references,
        assumptions: insight.assumptions.map((text) => render(text, field).text),
        openQuestions,
        ...(knownMetricIds.length > 0
          ? {
              figures: figuresFor(analysis, [
                ...knownMetricIds,
                ...knownAnomalies.map((anomaly) => anomaly.valueMetricId),
              ]),
            }
          : {}),
      }) - 1,
    );
  });

  const taskQuestions: OpenQuestionDraft[] = output.openQuestions.map((question, index) => ({
    text: render(question.text, `open question ${index + 1}`).text,
    severity: question.severity,
  }));
  let narrativeCheck: number | undefined;

  if (narrativeIssues.length > 0) {
    narrativeCheck =
      findings.push({
        summary: `${narrativeIssues.length} statement(s) in the narrative could not be matched to computed metrics.`,
        detail: narrativeIssues.map((issue) => `- ${issue.message}`).join("\n"),
        severity: "low",
        confidence: "high",
        evidence: [],
        openQuestions: narrativeIssues.slice(0, MAX_NARRATIVE_QUESTIONS).map((issue) => ({
          text: `${issue.message} Check this statement before relying on it.`,
          severity: "medium",
        })),
      }) - 1;
  }

  const segmentIndexes = [...built.segments.values()];
  const allAssumptions = [
    ...analysis.assumptions,
    ...analysis.issues.map((issue) => issue.treatment),
    ...assumptions,
  ];
  const allQuestions = [
    ...analysis.questions,
    ...analysis.anomalies.map((anomaly) => ({
      text: `What explains the ${anomaly.direction} in ${anomaly.period}?`,
      severity: "medium" as OpenQuestionSeverity,
    })),
    ...analysis.issues.map((issue) => ({ text: issue.question, severity: issue.severity })),
    ...output.insights.flatMap((_insight, position) => {
      const index = insightIndexes[position] as number;

      return (findings[index]?.openQuestions ?? []).map((question) => ({
        text: question.text,
        severity: question.severity,
      }));
    }),
    ...taskQuestions,
    ...(narrativeCheck === undefined
      ? []
      : (findings[narrativeCheck]?.openQuestions ?? []).map((question) => ({
          text: question.text,
          severity: question.severity,
        }))),
  ].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
  // Without a trend finding, monthly figures rest on the overview's amount and date evidence.
  const trendIndexes = built.trend === undefined ? [built.overview] : [built.trend];
  const sections: TaskSectionDraft[] = [
    {
      title: "Summary",
      kind: "text",
      content: summary.text,
      findingIndexes: [
        ...new Set([
          built.overview,
          ...trendIndexes,
          ...segmentIndexes,
          ...built.anomalies,
          ...insightIndexes,
        ]),
      ],
    },
    {
      title: "Key metrics",
      kind: "table",
      content: keyMetricsTable(analysis),
      findingIndexes: [built.overview, ...segmentIndexes],
    },
    {
      title: "Trends",
      kind: "text",
      content: [trends.text.trim(), monthlyTable(analysis)].filter(Boolean).join("\n\n"),
      findingIndexes: [...trendIndexes, ...segmentIndexes],
    },
    {
      title: "Anomalies",
      kind: "text",
      content: [anomalyNarrative.text.trim(), anomalyList(analysis)].filter(Boolean).join("\n\n"),
      findingIndexes: built.anomalies,
    },
    {
      title: "Data quality",
      kind: "table",
      content: dataQualityTable(analysis),
      findingIndexes: built.issues,
    },
    {
      title: "Assumptions and open questions",
      kind: "text",
      content: [
        "Assumptions",
        bulletList([...new Set(allAssumptions)]),
        "Open questions",
        allQuestions.length > 0
          ? bulletList(allQuestions.map((question) => `(${question.severity}) ${question.text}`))
          : "None.",
      ].join("\n\n"),
      findingIndexes: [
        built.overview,
        ...built.anomalies,
        ...built.issues,
        ...insightIndexes,
        ...(narrativeCheck === undefined ? [] : [narrativeCheck]),
      ],
    },
  ];
  const charts = buildDashboardCharts(analysis);

  for (const chart of charts) {
    const findingIndex =
      chart.subject === "overview"
        ? built.overview
        : chart.subject === "periods"
          ? (built.trend ?? built.overview)
          : (built.segments.get(chart.columnIndex ?? -1) ?? built.overview);

    sections.push({
      title: chart.spec.title,
      kind: "chart",
      content: JSON.stringify(chart.spec),
      deliverableKey: DATA_ANALYST_DASHBOARD_KEY,
      findingIndexes: [findingIndex],
    });
  }

  const deliverables: DeliverableSpec[] =
    charts.length > 0
      ? [
          {
            key: DATA_ANALYST_DASHBOARD_KEY,
            title: DATA_ANALYST_DASHBOARD_TITLE,
            format: "dashboard",
          },
        ]
      : [];

  return {
    findings,
    openQuestions: taskQuestions,
    sections,
    deliverables,
    usage: run.usage,
    cost: run.cost,
    ...(run.modelTier ? { modelTier: run.modelTier } : {}),
  };
}

export interface DataAnalystTaskHandlerOptions {
  /** Pins the agent; otherwise the registry's data analyst agent, or a default one, is used. */
  agent?: DataAnalystAgent;
  maxSampleRows?: number;
}

/**
 * Deterministic-then-interpret handler for the business-data-analyst role: computes metrics,
 * data-quality checks, and anomalies in plain TypeScript, then makes one structured model call.
 */
export function createDataAnalystTaskHandler(
  options: DataAnalystTaskHandlerOptions = {},
): TaskHandler {
  return {
    role: "business-data-analyst",
    async executeAsync(ctx) {
      const registered = ctx.agents.get("business-data-analyst");
      const agent =
        options.agent ?? (isDataAnalystAgent(registered) ? registered : createDataAnalystAgent());
      const sources = await loadTabularSourcesAsync(ctx);
      const source = selectAnalysisSource(sources);

      if (!source) {
        throw new DataAnalysisError(
          sources.length === 0 ? "no-tabular-data" : "no-amount-column",
          sources.length === 0
            ? "No spreadsheet data was found in the case. Upload the sales data as CSV or Excel and run again."
            : "No table in the uploaded spreadsheets has a numeric amount column (for example Amount, Revenue, or Sales).",
        );
      }

      const analysis = analyzeTable(source, { skippedTables: sources.length - 1 });
      const context = buildAnalystContext(analysis, options.maxSampleRows);
      const input = { ...buildSpecialistInput(ctx, context), documents: [] };
      const result: AgentResult<DataAnalystOutput> = await agent.runAsync(
        input,
        agentContextFor(ctx),
      );

      return withBilledUsageAsync(result, () =>
        buildDataAnalystTaskOutput(analysis, result.output, {
          usage: result.usage,
          cost: result.cost,
          modelTier: result.modelTier,
        }),
      );
    },
  };
}
