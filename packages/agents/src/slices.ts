import type {
  DocumentMetadata,
  ExtractedDocument,
  ExtractedTable,
  ExtractionMethod,
  RowRange,
} from "@evianta/core";

import { countMatchingTerms, estimateTokens, uniqueTerms } from "./text.js";

export const DEFAULT_DOCUMENT_TOKEN_BUDGET = 6000;

const MIN_TRUNCATED_SLICE_TOKENS = 120;

export interface DocumentSlice {
  documentId: string;
  documentName: string;
  kind: "page" | "table";
  /** 1-based page index for page slices, or the source page of a table when known. */
  page?: number;
  sheet?: string;
  table?: string;
  /** 1-based data rows included from the table. */
  rowRange?: RowRange;
  text: string;
  /** Extraction confidence in 0..1. */
  confidence?: number;
  method?: ExtractionMethod;
  truncated: boolean;
}

export interface SliceSource {
  metadata: DocumentMetadata;
  extraction?: ExtractedDocument;
}

export interface SliceOptions {
  /** Text used to rank pages and tables by relevance, for example the task title. */
  query?: string;
  tokenBudget?: number;
}

interface SliceUnit {
  order: number;
  score: number;
  build(maxTokens: number): DocumentSlice | undefined;
  fullTokens: number;
}

function renderRow(cells: readonly unknown[]): string {
  return cells.map((cell) => (cell === null || cell === undefined ? "" : String(cell))).join(" | ");
}

function truncationMarker(included: number, total: number): string {
  return `(showing rows 1-${included} of ${total})`;
}

function tableUnit(
  metadata: DocumentMetadata,
  extraction: ExtractedDocument,
  table: ExtractedTable,
  order: number,
  terms: ReadonlySet<string>,
): SliceUnit {
  const header = renderRow(table.columns.map((column) => `${column.name} (${column.type})`));
  const rows = table.rows.map((row) => renderRow(row));
  const fullText = [header, ...rows].join("\n");

  return {
    order,
    score: countMatchingTerms(terms, `${table.name} ${table.sheet ?? ""} ${fullText}`),
    fullTokens: estimateTokens(fullText),
    build(maxTokens) {
      const lines = [header];
      const markerCost = estimateTokens(truncationMarker(rows.length, rows.length)) + 1;
      let used = estimateTokens(header);
      let included = 0;

      for (const [index, row] of rows.entries()) {
        const cost = estimateTokens(row) + 1;
        const reserve = index === rows.length - 1 ? 0 : markerCost;

        if (used + cost + reserve > maxTokens) {
          break;
        }

        lines.push(row);
        used += cost;
        included += 1;
      }

      if (included === 0 && rows.length > 0) {
        return undefined;
      }

      const truncated = included < rows.length;

      if (truncated) {
        lines.push(truncationMarker(included, rows.length));
      }

      return {
        documentId: metadata.id,
        documentName: metadata.name,
        kind: "table",
        page: table.pageIndex,
        sheet: table.sheet,
        table: table.name,
        rowRange: included > 0 ? { start: 1, end: included } : undefined,
        text: lines.join("\n"),
        confidence: extraction.confidence,
        method: extraction.method,
        truncated,
      };
    },
  };
}

function windowAroundFirstMatch(text: string, terms: ReadonlySet<string>, maxChars: number) {
  const lower = text.toLowerCase();
  let firstMatch = -1;

  for (const term of terms) {
    const index = lower.indexOf(term);

    if (index !== -1 && (firstMatch === -1 || index < firstMatch)) {
      firstMatch = index;
    }
  }

  const start = firstMatch === -1 ? 0 : Math.max(0, firstMatch - Math.floor(maxChars / 4));

  return text.slice(start, start + maxChars);
}

function pageUnits(
  metadata: DocumentMetadata,
  extraction: ExtractedDocument,
  startOrder: number,
  terms: ReadonlySet<string>,
): SliceUnit[] {
  return extraction.pages
    .filter((page) => page.text.trim().length > 0)
    .map((page, offset) => ({
      order: startOrder + offset,
      score: countMatchingTerms(terms, page.text),
      fullTokens: estimateTokens(page.text),
      build(maxTokens) {
        const maxChars = maxTokens * 4;
        const truncated = page.text.length > maxChars;

        return {
          documentId: metadata.id,
          documentName: metadata.name,
          kind: "page",
          page: page.index,
          text: truncated ? windowAroundFirstMatch(page.text, terms, maxChars) : page.text,
          confidence: page.confidence,
          method: page.method,
          truncated,
        };
      },
    }));
}

function unitsFor(source: SliceSource, terms: ReadonlySet<string>): SliceUnit[] {
  const { metadata, extraction } = source;

  if (!extraction) {
    return [];
  }

  const tables = extraction.tables.map((table, index) =>
    tableUnit(metadata, extraction, table, index, terms),
  );
  const pages = pageUnits(metadata, extraction, tables.length, terms);

  return [...tables, ...pages].sort((left, right) => right.score - left.score);
}

/**
 * Selects the most relevant pages and tables of each document within a token budget, splitting
 * the budget evenly across documents and handing unused share to the remaining units.
 */
export function sliceDocuments(
  sources: readonly SliceSource[],
  options: SliceOptions = {},
): DocumentSlice[] {
  const budget = options.tokenBudget ?? DEFAULT_DOCUMENT_TOKEN_BUDGET;
  const terms = uniqueTerms(options.query ?? "");
  const perDocument = sources.map((source) => unitsFor(source, terms));
  const withUnits = perDocument.filter((units) => units.length > 0).length;

  if (withUnits === 0 || budget <= 0) {
    return [];
  }

  const share = Math.floor(budget / withUnits);
  const selected: Array<{ documentIndex: number; order: number; slice: DocumentSlice }> = [];
  const taken = perDocument.map(() => new Set<SliceUnit>());
  let used = 0;

  perDocument.forEach((units, documentIndex) => {
    let documentUsed = 0;

    for (const unit of units) {
      const remaining = share - documentUsed;

      if (unit.fullTokens <= remaining) {
        const slice = unit.build(Number.POSITIVE_INFINITY);

        if (slice) {
          selected.push({ documentIndex, order: unit.order, slice });
          taken[documentIndex]?.add(unit);
          documentUsed += unit.fullTokens;
        }

        continue;
      }

      if (remaining >= MIN_TRUNCATED_SLICE_TOKENS) {
        const slice = unit.build(remaining);

        if (slice) {
          selected.push({ documentIndex, order: unit.order, slice });
          taken[documentIndex]?.add(unit);
          documentUsed += estimateTokens(slice.text);
        }
      }

      break;
    }

    used += documentUsed;
  });

  perDocument.forEach((units, documentIndex) => {
    for (const unit of units) {
      const remaining = budget - used;

      if (taken[documentIndex]?.has(unit)) {
        continue;
      }

      if (unit.fullTokens <= remaining) {
        const slice = unit.build(Number.POSITIVE_INFINITY);

        if (slice) {
          selected.push({ documentIndex, order: unit.order, slice });
          used += unit.fullTokens;
        }

        continue;
      }

      if (remaining >= MIN_TRUNCATED_SLICE_TOKENS) {
        const slice = unit.build(remaining);

        if (slice) {
          selected.push({ documentIndex, order: unit.order, slice });
          used += estimateTokens(slice.text);
        }
      }
    }
  });

  return selected
    .sort((left, right) => left.documentIndex - right.documentIndex || left.order - right.order)
    .map((entry) => entry.slice);
}
