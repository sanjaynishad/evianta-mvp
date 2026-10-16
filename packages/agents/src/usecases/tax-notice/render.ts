import type { EvidenceReference } from "../../findings.js";
import { truncate } from "../../text.js";
import { formatAmount, markdownTable } from "./constants.js";
import type { TaxRecordRow, TaxRecordSource } from "./records.js";
import {
  describeLineStatus,
  primaryTaxDifference,
  sourceLabel,
  type ReconciliationLine,
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

export function lineEvidence(line: ReconciliationLine): EvidenceReference[] {
  return Object.entries(line.values)
    .flatMap(([source, values]) =>
      (values?.rows ?? []).map((row) =>
        rowEvidence(
          row,
          `${line.ref} ${sourceLabel(source as TaxRecordSource)} row for ${line.deductorName}`,
        ),
      ),
    )
    .slice(0, MAX_ROW_EVIDENCE_PER_LINE);
}

function amountCell(line: ReconciliationLine, source: TaxRecordSource, provided: boolean): string {
  if (!provided) {
    return "n/a";
  }

  const tax = line.values[source]?.tax;

  return tax === undefined ? "-" : formatAmount(tax);
}

function incomeCell(line: ReconciliationLine, sources: readonly TaxRecordSource[]): string {
  return sources
    .map((source) => {
      const amount = line.values[source]?.amount;

      return amount === undefined ? "-" : formatAmount(amount);
    })
    .join(" / ");
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
  const total = (source: TaxRecordSource) => {
    const value = bySource[source]?.tax;

    return value === undefined ? "n/a" : formatAmount(value);
  };

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
    sources
      .map((source) => {
        const amount = bySource[source]?.amount;

        return amount === undefined ? "-" : formatAmount(amount);
      })
      .join(" / "),
    "",
    "",
  ]);

  return [
    markdownTable(headers, rows),
    "",
    `Difference is TDS per return less TDS per 26AS/AIS (ledger less 26AS/AIS when no return is provided). Amounts agreeing within Rs ${formatAmount(reconciliation.tolerance)} are treated as matched.`,
  ].join("\n");
}
