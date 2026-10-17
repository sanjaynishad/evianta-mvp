import type { EvidenceReference } from "../../findings.js";
import { truncate } from "../../text.js";
import { formatAmount, markdownTable } from "./constants.js";
import type { TaxMeasure, TaxRecordRow, TaxRecordSource } from "./records.js";
import {
  describeLineStatus,
  primaryTaxDifference,
  sourceLabel,
  type ReconciliationLine,
  type SourceTotals,
  type SourceValues,
  type TaxReconciliation,
} from "./reconcile.js";

export const MAX_ROW_EVIDENCE_PER_LINE = 8;

export function rowLocationLabel(row: TaxRecordRow): string {
  const cell = row.location.cellRange;
  const where = row.location.sheet && cell ? `${row.location.sheet}!${cell}` : cell;

  return where ? `${row.documentName} ${where}` : `${row.documentName} row ${row.rowIndex + 1}`;
}

export function rowEvidence(row: TaxRecordRow, description: string): EvidenceReference {
  const { location } = row;

  return {
    documentId: row.documentId,
    description,
    ...(location.sheet ? { sheet: location.sheet } : {}),
    ...(location.cellRange ? { cellRange: location.cellRange } : {}),
    ...(location.rowRange
      ? { rowStart: location.rowRange.start, rowEnd: location.rowRange.end }
      : {}),
    textQuote: truncate(row.quote, 240),
  };
}

/** Takes rows from each source in turn, so every compared side keeps evidence under the cap. */
export function lineEvidence(line: ReconciliationLine): EvidenceReference[] {
  const bySource = Object.entries(line.values).map(([source, values]) =>
    (values?.rows ?? []).map((row) =>
      rowEvidence(
        row,
        `${line.ref} ${sourceLabel(source as TaxRecordSource)} row for ${line.deductorName}`,
      ),
    ),
  );
  const picked: EvidenceReference[] = [];
  const longest = Math.max(0, ...bySource.map((rows) => rows.length));

  for (let position = 0; position < longest; position += 1) {
    for (const rows of bySource) {
      const reference = rows[position];

      if (reference && picked.length < MAX_ROW_EVIDENCE_PER_LINE) {
        picked.push(reference);
      }
    }
  }

  return picked;
}

function amountCell(line: ReconciliationLine, source: TaxRecordSource, provided: boolean): string {
  if (!provided) {
    return "n/a";
  }

  return valueCell(line.values[source], "tax");
}

function valueCell(values: SourceValues | SourceTotals | undefined, measure: TaxMeasure): string {
  const value = values?.[measure];

  if (value !== undefined) {
    return formatAmount(value);
  }

  return values?.unreadable.includes(measure) ? "unreadable" : "-";
}

function incomeCell(line: ReconciliationLine, sources: readonly TaxRecordSource[]): string {
  return sources.map((source) => valueCell(line.values[source], "amount")).join(" / ");
}

function sourceCell(line: ReconciliationLine): string {
  return Object.values(line.values)
    .flatMap((values) => values?.rows ?? [])
    .map(rowLocationLabel)
    .join("; ");
}

/** The reconciliation table: one row per deductor and period, then totals. */
export function reconciliationTableMarkdown(reconciliation: TaxReconciliation): string {
  const provided = new Set(reconciliation.providedSources);
  const sources = reconciliation.providedSources;
  const headers = [
    "Ref",
    "Deductor (TAN)",
    "Section",
    "Period",
    "TDS per return",
    "TDS per ledger",
    "TDS per 26AS/AIS",
    "Difference",
    `Amount (${sources.map(sourceLabel).join(" / ")})`,
    "Status",
    "Source cells",
  ];
  const rows = reconciliation.lines.map((line) => {
    const delta = primaryTaxDifference(line);

    return [
      line.ref,
      line.tan ? `${line.deductorName} (${line.tan})` : line.deductorName,
      line.section ?? "-",
      line.period,
      amountCell(line, "return", provided.has("return")),
      amountCell(line, "ledger", provided.has("ledger")),
      amountCell(line, "tax-credit", provided.has("tax-credit")),
      delta === undefined ? "-" : formatAmount(delta),
      incomeCell(line, sources),
      describeLineStatus(line),
      sourceCell(line),
    ];
  });
  const { bySource, returnVsTaxCredit, ledgerVsTaxCredit } = reconciliation.totals;
  const total = (source: TaxRecordSource) =>
    provided.has(source) ? valueCell(bySource[source], "tax") : "n/a";

  const totalDelta = returnVsTaxCredit?.tax ?? ledgerVsTaxCredit?.tax;

  rows.push([
    "Total",
    "",
    "",
    "",
    total("return"),
    total("ledger"),
    total("tax-credit"),
    totalDelta === undefined ? "-" : formatAmount(totalDelta),
    sources.map((source) => valueCell(bySource[source], "amount")).join(" / "),
    "",
    "",
  ]);

  return [
    markdownTable(headers, rows),
    "",
    `Difference is TDS per return less TDS per 26AS/AIS (ledger less 26AS/AIS when no return is provided). Amounts agreeing within Rs ${formatAmount(reconciliation.tolerance)} are treated as matched.`,
  ].join("\n");
}
