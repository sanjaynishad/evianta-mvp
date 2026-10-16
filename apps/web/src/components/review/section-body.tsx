"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import type { DeliverableSection } from "@evianta/core";
import { ChartSection } from "@/components/dashboard/chart-section";
import { Timeline } from "@/components/patterns/timeline";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EvidenceEntry } from "@/lib/evidence";
import { parseTextTable, parseTextTimeline, type TextTable } from "@/lib/section-content";
import { cn } from "@/lib/utils";
import { EvidenceHoverChip } from "./evidence-hover-chip";

export interface SectionBodyProps {
  section: DeliverableSection;
  content: string;
  sources: EvidenceEntry[];
  onOpenEvidence: (evidenceId: string) => void;
  isEvidenceHighlighted?: (evidenceId: string) => boolean;
}

function PlainBlock({ content }: { content: string }) {
  return (
    <pre className="figures overflow-x-auto whitespace-pre rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground print:whitespace-pre-wrap print:bg-transparent">
      {content}
    </pre>
  );
}

function Paragraphs({ content }: { content: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {content
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim().length > 0)
        .map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
    </div>
  );
}

interface ComparisonTableProps {
  title: string;
  table: TextTable;
  sources: EvidenceEntry[];
  onOpenEvidence: (evidenceId: string) => void;
  isEvidenceHighlighted?: (evidenceId: string) => boolean;
}

function ComparisonTable({
  title,
  table,
  sources,
  onOpenEvidence,
  isEvidenceHighlighted,
}: ComparisonTableProps) {
  const compares = table.differenceColumn !== undefined;
  const discrepancies = table.rows.filter((row) => row.discrepancy).length;
  const matched = table.rows.length - discrepancies;
  const showSources = sources.length > 0;

  function renderCells(cells: string[]) {
    return table.headers.map((header, index) => (
      <TableCell
        key={header}
        numeric={table.numericColumns[index]}
        className={cn(index === 0 && "whitespace-nowrap font-medium")}
      >
        {cells[index] || (table.numericColumns[index] ? "-" : "")}
      </TableCell>
    ));
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table data-comparison-table={compares || undefined}>
        <TableCaption className="pb-3 text-left">
          {compares
            ? `${matched} matched, ${discrepancies} ${discrepancies === 1 ? "discrepancy" : "discrepancies"}. Each row links to the sources compared.`
            : `${title}. Sources are linked on each row.`}
        </TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {table.headers.map((header, index) => (
              <TableHead key={header} scope="col" numeric={table.numericColumns[index]}>
                {header}
              </TableHead>
            ))}
            {compares ? <TableHead scope="col">Status</TableHead> : null}
            {showSources ? (
              <TableHead scope="col" className="print:hidden">
                Sources
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, rowIndex) => (
            <TableRow
              key={`${row.cells[0]}-${rowIndex}`}
              data-row-status={
                row.discrepancy === undefined
                  ? undefined
                  : row.discrepancy
                    ? "discrepancy"
                    : "matched"
              }
              className={cn(
                row.discrepancy && "bg-danger-subtle/60 shadow-[inset_3px_0_0_hsl(var(--danger))]",
              )}
            >
              {renderCells(row.cells)}
              {compares ? (
                <TableCell>
                  {row.discrepancy ? (
                    <Badge variant="danger">
                      <TriangleAlert aria-hidden />
                      Discrepancy
                    </Badge>
                  ) : (
                    <Badge variant="success">
                      <CircleCheck aria-hidden />
                      Matched
                    </Badge>
                  )}
                </TableCell>
              ) : null}
              {showSources ? (
                <TableCell className="print:hidden">
                  <ul
                    aria-label={`Sources for ${row.cells[0] ?? "row"}`}
                    className="flex flex-wrap gap-1"
                  >
                    {sources.map((entry) => (
                      <li key={entry.evidence.id}>
                        <EvidenceHoverChip
                          entry={entry}
                          onOpen={onOpenEvidence}
                          selected={isEvidenceHighlighted?.(entry.evidence.id) ?? false}
                          className="max-w-[11rem]"
                        />
                      </li>
                    ))}
                  </ul>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
        {table.total ? (
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              {renderCells(table.total.cells)}
              {compares ? (
                <TableCell>
                  {table.total.discrepancy ? (
                    <Badge variant="danger">Net difference</Badge>
                  ) : (
                    <Badge variant="success">Balanced</Badge>
                  )}
                </TableCell>
              ) : null}
              {showSources ? <TableCell className="print:hidden" /> : null}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </div>
  );
}

export function SectionBody({
  section,
  content,
  sources,
  onOpenEvidence,
  isEvidenceHighlighted,
}: SectionBodyProps) {
  if (section.kind === "chart") {
    return <ChartSection section={{ ...section, editedContent: content }} />;
  }

  if (section.kind === "table") {
    const table = parseTextTable(content);
    return table ? (
      <ComparisonTable
        title={section.title}
        table={table}
        sources={sources}
        onOpenEvidence={onOpenEvidence}
        isEvidenceHighlighted={isEvidenceHighlighted}
      />
    ) : (
      <PlainBlock content={content} />
    );
  }

  if (section.kind === "timeline") {
    const entries = parseTextTimeline(content);
    return entries ? (
      <Timeline
        aria-label={section.title}
        items={entries.map((entry, index) => ({
          id: entry.id,
          date: entry.date,
          title: entry.text,
          tone: index === entries.length - 1 ? "primary" : "neutral",
        }))}
      />
    ) : (
      <PlainBlock content={content} />
    );
  }

  return <Paragraphs content={content} />;
}
