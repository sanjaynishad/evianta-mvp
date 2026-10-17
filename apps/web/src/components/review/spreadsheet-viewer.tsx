"use client";

import { useEffect, useRef, useState } from "react";
import { Table2 } from "lucide-react";
import type { ExtractedTable, TableCell } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import type { EvidenceEntry } from "@/lib/evidence";
import {
  columnLabel,
  findTableForLocation,
  locationMatchesSheet,
  rangeContainsCell,
  rangeContainsRow,
  sheetRangeOf,
  tableLayout,
  type SheetRange,
} from "@/lib/evidence-location";
import { evidenceForRow } from "@/lib/evidence-regions";
import { formatNumber } from "@/lib/format";
import { scrollIntoPane } from "@/lib/scroll";
import { cn } from "@/lib/utils";

export interface SpreadsheetViewerProps {
  documentName: string;
  tables: ExtractedTable[];
  entries: EvidenceEntry[];
  focusEvidenceId?: string;
  requestId: number;
  selectedRow?: { sheet: string; row: number };
  onSelectRow: (sheet: string, row: number, evidenceIds: string[]) => void;
}

const contextRows = 5;
const maxWindowRows = 60;
const stepRows = 25;

interface RowWindow {
  start: number;
  end: number;
}

function initialWindow(
  focus: SheetRange | undefined,
  firstRow: number,
  lastRow: number,
): RowWindow {
  if (!focus) {
    return { start: firstRow, end: Math.min(lastRow, firstRow + maxWindowRows - 1) };
  }

  const start = Math.max(firstRow, focus.startRow - contextRows);
  const end = Math.min(lastRow, Math.min(focus.endRow + contextRows, start + maxWindowRows - 1));
  return { start, end: Math.max(start, end) };
}

export function formatCell(value: TableCell): string {
  if (value === null) {
    return "";
  }

  if (typeof value === "number") {
    // Keep the source precision: rates and small amounts must stay verifiable.
    return formatNumber(value, { maximumFractionDigits: 20 });
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  return value;
}

export function SpreadsheetViewer({
  documentName,
  tables,
  entries,
  focusEvidenceId,
  requestId,
  selectedRow,
  onSelectRow,
}: SpreadsheetViewerProps) {
  const { reduced } = useMotionSafe();
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusEntry = entries.find((entry) => entry.evidence.id === focusEvidenceId);
  const focusTable = findTableForLocation(tables, focusEntry?.evidence.location);
  const [sheetChoice, setSheetChoice] = useState<{ requestId: number; name: string }>();
  const table =
    (sheetChoice?.requestId === requestId
      ? tables.find((candidate) => candidate.name === sheetChoice.name)
      : undefined) ?? focusTable;
  const layout = table ? tableLayout(table) : undefined;
  const focusRange =
    table && focusEntry && locationMatchesSheet(focusEntry.evidence.location, table)
      ? sheetRangeOf(focusEntry.evidence.location)
      : undefined;
  const firstRow = layout?.firstDataRow ?? 2;
  const lastRow = firstRow + (table?.rows.length ?? 0) - 1;
  const windowKey = `${requestId}:${table?.name ?? ""}`;
  const [windowState, setWindowState] = useState<{ key: string; window: RowWindow }>();
  const rowWindow =
    windowState?.key === windowKey
      ? windowState.window
      : initialWindow(focusRange, firstRow, lastRow);
  const otherRanges = table
    ? entries
        .filter(
          (entry) =>
            entry.evidence.id !== focusEvidenceId &&
            locationMatchesSheet(entry.evidence.location, table),
        )
        .map((entry) => sheetRangeOf(entry.evidence.location))
        .filter((range): range is SheetRange => range !== undefined)
    : [];

  useEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>("[data-focus-row]");
    const target = row?.querySelector<HTMLElement>("[data-cell][data-highlighted]") ?? row;

    if (target) {
      scrollIntoPane(target, { block: "center", behavior: reduced ? "auto" : "smooth" });
    }
  }, [requestId, reduced, table?.name]);

  if (!table || !layout) {
    return (
      <EmptyState
        icon={Table2}
        title="No table was read from this file"
        description="Use View original to open the spreadsheet."
      />
    );
  }

  const sheetName = table.sheet ?? table.name;
  const columns = table.columns.map((column, index) => ({
    ...column,
    number: layout.firstColumn + index,
  }));
  const visibleRows = table.rows
    .map((cells, index) => ({ cells, row: firstRow + index }))
    .filter(({ row }) => row >= rowWindow.start && row <= rowWindow.end);
  const firstFocusRow = focusRange ? Math.max(focusRange.startRow, rowWindow.start) : undefined;

  return (
    <div className="flex flex-col gap-2">
      {tables.length > 1 ? (
        <div role="group" aria-label="Sheets" className="flex flex-wrap gap-1">
          {tables.map((candidate) => (
            <Button
              key={candidate.name}
              size="sm"
              variant={candidate.name === table.name ? "secondary" : "ghost"}
              aria-pressed={candidate.name === table.name}
              onClick={() => setSheetChoice({ requestId, name: candidate.name })}
            >
              {candidate.sheet ?? candidate.name}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Sheet {sheetName}, rows {rowWindow.start} to {rowWindow.end} of {lastRow}.
        {focusRange && focusRange.endRow > rowWindow.end
          ? ` The highlighted range continues to row ${focusRange.endRow}.`
          : ""}
      </p>
      {rowWindow.start > firstRow ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          onClick={() =>
            setWindowState({
              key: windowKey,
              window: { start: Math.max(firstRow, rowWindow.start - stepRows), end: rowWindow.end },
            })
          }
        >
          Show earlier rows
        </Button>
      ) : null}
      <div
        ref={scrollRef}
        data-slot="spreadsheet-viewer"
        className="relative max-h-[60vh] overflow-auto rounded-md border bg-card"
      >
        <table
          aria-label={`${documentName}, sheet ${sheetName}`}
          className="w-max min-w-full border-collapse text-xs"
        >
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th scope="col" className="w-14 border-b border-r px-2 py-1 text-muted-foreground">
                <span className="sr-only">Row</span>
              </th>
              {columns.map((column) => (
                <th
                  key={column.number}
                  scope="col"
                  className="border-b border-r px-2 py-1 text-left font-medium"
                >
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {columnLabel(column.number)}
                  </span>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ cells, row }) => {
              const focused = focusRange ? rangeContainsRow(focusRange, row) : false;
              const cited = otherRanges.some((range) => rangeContainsRow(range, row));
              const selected = selectedRow?.sheet === sheetName && selectedRow.row === row;
              return (
                <tr
                  key={focused ? `${row}-${requestId}` : row}
                  data-row={row}
                  data-focus-row={row === firstFocusRow || undefined}
                  data-highlighted={focused || undefined}
                  className={cn(
                    "border-b",
                    focused && "animate-evidence-pulse motion-reduce:animate-none",
                    selected && "outline outline-2 -outline-offset-2 outline-primary",
                  )}
                >
                  <th scope="row" className="border-r bg-muted/60 p-0 text-right font-normal">
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`Row ${row}${focused ? ", highlighted" : cited ? ", cited" : ""}. Show the findings that cite it.`}
                      onClick={() =>
                        onSelectRow(
                          sheetName,
                          row,
                          evidenceForRow(entries, table, row).map((entry) => entry.evidence.id),
                        )
                      }
                      className={cn(
                        "figures block w-full px-2 py-1 text-right text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        cited && !focused && "shadow-[inset_3px_0_0_hsl(var(--primary)/0.6)]",
                        focused && "bg-highlight text-highlight-foreground",
                      )}
                    >
                      {row}
                    </button>
                  </th>
                  {columns.map((column, index) => {
                    const value = cells[index] ?? null;
                    const highlighted = focusRange
                      ? rangeContainsCell(focusRange, row, column.number)
                      : false;
                    return (
                      <td
                        key={column.number}
                        data-cell={`${columnLabel(column.number)}${row}`}
                        data-highlighted={highlighted || undefined}
                        className={cn(
                          "max-w-64 truncate border-r px-2 py-1",
                          typeof value === "number" && "figures text-right",
                          highlighted && "bg-highlight/15 font-medium text-foreground",
                        )}
                      >
                        {formatCell(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rowWindow.end < lastRow ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          onClick={() =>
            setWindowState({
              key: windowKey,
              window: { start: rowWindow.start, end: Math.min(lastRow, rowWindow.end + stepRows) },
            })
          }
        >
          Show more rows
        </Button>
      ) : null}
    </div>
  );
}
