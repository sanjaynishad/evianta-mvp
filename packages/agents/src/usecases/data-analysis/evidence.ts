import type { EvidenceLocation, ExtractedTable } from "@evianta/core";
import { tableEvidenceLocation } from "@evianta/ingest";

export const MAX_LOCATIONS_PER_ITEM = 5;

type LocatableTable = Pick<ExtractedTable, "range" | "sheet" | "columns">;

/** Groups sorted row indexes into consecutive runs. */
export function rowRuns(rows: readonly number[]): Array<{ start: number; end: number }> {
  const sorted = [...new Set(rows)].sort((left, right) => left - right);
  const runs: Array<{ start: number; end: number }> = [];

  for (const row of sorted) {
    const last = runs[runs.length - 1];

    if (last && row === last.end + 1) {
      last.end = row;
      continue;
    }

    runs.push({ start: row, end: row });
  }

  return runs;
}

/** Cell-range locations for the given data rows of one column, or of whole rows. */
export function rowLocations(
  table: LocatableTable,
  rows: readonly number[],
  column?: number,
  limit = MAX_LOCATIONS_PER_ITEM,
): EvidenceLocation[] {
  return rowRuns(rows)
    .slice(0, limit)
    .map((run) =>
      tableEvidenceLocation(table, {
        rowStart: run.start,
        rowEnd: run.end,
        ...(column === undefined ? {} : { columnStart: column, columnEnd: column }),
      }),
    );
}

/** The whole data range of one column. */
export function columnLocation(
  table: LocatableTable & Pick<ExtractedTable, "rows">,
  column: number,
): EvidenceLocation {
  return tableEvidenceLocation(table, {
    rowStart: 0,
    rowEnd: Math.max(0, table.rows.length - 1),
    columnStart: column,
    columnEnd: column,
  });
}

export function describeLocation(location: EvidenceLocation): string {
  const range = location.cellRange ?? "";

  return location.sheet ? `${location.sheet}!${range}` : range;
}
