"use client";

import type { ReactNode } from "react";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  LocateFixed,
  PenLine,
  ScanText,
  SearchX,
  X,
} from "lucide-react";
import type { CaseDocument, ExtractedDocument } from "@evianta/core";
import { ConfidenceBadge } from "@/components/patterns/confidence-badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import {
  formatEvidenceLocator,
  getDocumentKind,
  getEvidenceLabel,
  type EvidenceEntry,
} from "@/lib/evidence";
import { isApproximateMethod } from "@/lib/evidence-location";
import { entriesForDocument, findingIdsForEvidence, regionForEntry } from "@/lib/evidence-regions";
import { formatPercent } from "@/lib/format";
import { extractionMethodLabels } from "@/lib/labels";
import { useReview, type SourceSelection } from "./review-context";
import { ImageViewer, PdfViewer } from "./page-viewers";
import { SpreadsheetViewer } from "./spreadsheet-viewer";
import { TextSourceViewer } from "./text-source-viewer";

const lowReadingConfidence = 0.75;

export interface SectionReference {
  sectionId: string;
  title: string;
}

export interface EvidenceViewerProps {
  documents: CaseDocument[];
  sectionsByEvidence: Map<string, SectionReference[]>;
  // Rendered when no source is open: the document list with uploads.
  sourceList: ReactNode;
}

function ReadingBadges({
  document,
  extraction,
  page,
}: {
  document: CaseDocument;
  extraction?: ExtractedDocument;
  page?: number;
}) {
  const method = extraction?.method ?? document.extraction?.method;
  const pageReading = extraction?.pages.find((candidate) => candidate.index === page);
  const readMethod = pageReading?.method ?? method;
  const confidence =
    pageReading?.confidence ?? extraction?.confidence ?? document.extraction?.confidence;
  const isScan = readMethod === "ocr" || readMethod === "handwriting";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {method ? <Badge variant="neutral">{extractionMethodLabels[method]}</Badge> : null}
      {isScan && confidence !== undefined ? (
        <Badge
          variant={confidence < lowReadingConfidence ? "warning" : "info"}
          data-testid="reading-confidence"
        >
          {readMethod === "handwriting" ? <PenLine aria-hidden /> : <ScanText aria-hidden />}
          {readMethod === "handwriting" ? "Handwriting" : "OCR"} confidence{" "}
          {formatPercent(confidence, 0)}
        </Badge>
      ) : null}
    </div>
  );
}

function EvidenceDetails({ entry }: { entry: EvidenceEntry }) {
  const { evidence } = entry;
  const review = useReview();
  const locator = formatEvidenceLocator(evidence.location);
  const quote = evidence.location?.textQuote ?? evidence.excerpt;
  const findings = entry.findingIds
    .map((id) => review.findingsById.get(id))
    .filter((finding) => finding !== undefined);
  return (
    <section
      aria-label="Selected evidence"
      data-testid="evidence-details"
      className="flex flex-col gap-2 rounded-md border border-highlight/30 bg-highlight-subtle/40 p-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        <LocateFixed aria-hidden className="mt-0.5 size-4 shrink-0 text-highlight" />
        <p className="min-w-0 flex-1 text-sm font-medium">{evidence.description}</p>
        <ConfidenceBadge level={evidence.confidence ?? "unassessed"} compact />
      </div>
      {locator ? <p className="figures text-xs text-muted-foreground">{locator}</p> : null}
      {quote ? (
        <blockquote className="border-l-2 border-highlight pl-3 text-sm">{quote}</blockquote>
      ) : null}
      {findings.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Supports</p>
          <ul className="flex flex-col gap-1">
            {findings.map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  onClick={() => review.focusFinding(finding.id)}
                  className="rounded-sm text-left text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {finding.summary}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export interface ReverseLookupProps {
  selection: SourceSelection;
  sectionsByEvidence: Map<string, SectionReference[]>;
}

export function ReverseLookup({ selection, sectionsByEvidence }: ReverseLookupProps) {
  const review = useReview();
  const entries = selection.evidenceIds
    .map((id) => review.evidenceIndex.get(id))
    .filter((entry): entry is EvidenceEntry => entry !== undefined);
  const findings = findingIdsForEvidence(entries)
    .map((id) => review.findingsById.get(id))
    .filter((finding) => finding !== undefined);
  const sections = [
    ...new Map(
      selection.evidenceIds
        .flatMap((id) => sectionsByEvidence.get(id) ?? [])
        .map((section) => [section.sectionId, section]),
    ).values(),
  ];
  const headline =
    findings.length === 0
      ? `No findings cite ${selection.label}`
      : `${findings.length} ${findings.length === 1 ? "finding cites" : "findings cite"} ${selection.label}`;
  return (
    <section
      aria-label="Findings citing the selection"
      data-testid="reverse-lookup"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium" aria-live="polite">
          {headline}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear the selection"
          onClick={() => review.setSelection(undefined)}
        >
          <X aria-hidden />
        </Button>
      </div>
      {findings.length > 0 ? (
        <ul aria-label="Citing findings" className="flex flex-col gap-1">
          {findings.map((finding) => (
            <li key={finding.id}>
              <button
                type="button"
                onClick={() => review.focusFinding(finding.id)}
                className="rounded-sm text-left text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {finding.summary}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {sections.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Used in</p>
          <ul aria-label="Citing sections" className="flex flex-wrap gap-1.5">
            {sections.map((section) => (
              <li key={section.sectionId}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => review.focusSection(section.sectionId)}
                >
                  {section.title}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function WebSource({ entry }: { entry: EvidenceEntry }) {
  const isUrl = /^https?:\/\//i.test(entry.evidence.sourceRef);
  return (
    <div className="flex flex-col gap-3">
      <EvidenceDetails entry={entry} />
      <div className="flex flex-col gap-2 rounded-md border bg-card p-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Globe aria-hidden className="size-4 text-muted-foreground" />
          {isUrl ? "Web source" : "Source without a stored file"}
        </p>
        {isUrl ? (
          <a
            href={entry.evidence.sourceRef}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1 break-all text-primary underline-offset-4 hover:underline"
          >
            {entry.evidence.sourceRef}
            <ExternalLink aria-hidden className="size-3.5 shrink-0" />
          </a>
        ) : (
          <p className="text-muted-foreground">{entry.evidence.sourceRef}</p>
        )}
        <p className="text-xs text-muted-foreground">
          Research sources are cited by the research specialist. Verify them against the current law
          before relying on them.
        </p>
      </div>
    </div>
  );
}

interface DocumentSourceProps {
  document: CaseDocument;
  focusEntry?: EvidenceEntry;
  sectionsByEvidence: Map<string, SectionReference[]>;
}

function DocumentSource({ document, focusEntry, sectionsByEvidence }: DocumentSourceProps) {
  const review = useReview();
  const dataSource = useDataSource();
  const detail = useResource(`document:${review.caseId}:${document.id}`, () =>
    dataSource.getDocumentAsync(review.caseId, document.id),
  );
  const extraction = detail.data?.extraction;
  const fileUrl = dataSource.getDocumentFileUrl(review.caseId, document.id);
  const kind = getDocumentKind(document);
  const entries = entriesForDocument(review.evidenceIndex, document.id);
  const requestId = review.target?.requestId ?? 0;
  const selection = review.selection;
  const focusRegion = focusEntry
    ? regionForEntry(focusEntry, extraction, extraction?.pages.length || undefined)
    : undefined;
  const approximate =
    kind === "spreadsheet"
      ? false
      : (focusRegion?.highlight.approximate ??
        isApproximateMethod(extraction?.method ?? document.extraction?.method));

  function selectEvidence(evidenceIds: string[], label: string) {
    review.setSelection({ documentId: document.id, label, evidenceIds });
  }

  let viewer: ReactNode;
  if (detail.loading && !detail.data) {
    viewer = <Skeleton className="h-96 w-full" />;
  } else if (detail.error && !detail.data) {
    viewer = (
      <EmptyState
        icon={SearchX}
        title="Could not load this source"
        description={describeError(detail.error)}
        action={
          <Button variant="outline" size="sm" onClick={detail.reload}>
            Try again
          </Button>
        }
      />
    );
  } else if (kind === "spreadsheet") {
    viewer = (
      <SpreadsheetViewer
        documentName={document.name}
        tables={extraction?.tables ?? []}
        entries={entries}
        focusEvidenceId={focusEntry?.evidence.id}
        requestId={requestId}
        selectedRow={selection?.documentId === document.id ? selection.sheetRow : undefined}
        onSelectRow={(sheet, row, evidenceIds) =>
          review.setSelection({
            documentId: document.id,
            label: `${sheet} row ${row}`,
            evidenceIds,
            sheetRow: { sheet, row },
          })
        }
      />
    );
  } else if (kind === "pdf" && fileUrl) {
    viewer = (
      <PdfViewer
        document={document}
        extraction={extraction}
        fileUrl={fileUrl}
        entries={entries}
        focusEvidenceId={focusEntry?.evidence.id}
        requestId={requestId}
        selectedEvidenceIds={selection?.documentId === document.id ? selection.evidenceIds : []}
        onSelectRegions={selectEvidence}
      />
    );
  } else if (kind === "image" && fileUrl) {
    viewer = (
      <ImageViewer
        document={document}
        extraction={extraction}
        fileUrl={fileUrl}
        entries={entries}
        focusEvidenceId={focusEntry?.evidence.id}
        requestId={requestId}
        selectedEvidenceIds={selection?.documentId === document.id ? selection.evidenceIds : []}
        onSelectRegions={selectEvidence}
        alt={`${document.name}${extraction?.pages[0]?.text ? `: ${extraction.pages[0].text.replace(/\s+/g, " ")}` : ""}`}
      />
    );
  } else {
    viewer = (
      <TextSourceViewer
        documentName={document.name}
        extraction={extraction}
        page={focusEntry?.evidence.location?.page ?? 1}
        quote={focusEntry?.evidence.location?.textQuote}
        requestId={requestId}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-document-id={document.id} data-viewer-kind={kind}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={document.name}>
          {document.name}
        </h3>
        {fileUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={fileUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink aria-hidden />
              View original
            </a>
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ReadingBadges
          document={document}
          extraction={extraction}
          page={focusEntry?.evidence.location?.page}
        />
        {focusEntry && approximate ? (
          <Badge variant="warning" data-testid="approximate-highlight">
            Approximate highlight
          </Badge>
        ) : null}
      </div>
      {focusEntry && approximate ? (
        <p className="text-xs text-muted-foreground">
          This source was read from a scan or handwriting, so the highlighted position is an
          estimate. Check it against the original.
        </p>
      ) : null}
      {focusEntry ? <EvidenceDetails entry={focusEntry} /> : null}
      {selection && selection.documentId === document.id ? (
        <ReverseLookup selection={selection} sectionsByEvidence={sectionsByEvidence} />
      ) : null}
      {viewer}
    </div>
  );
}

export function EvidenceViewer({ documents, sectionsByEvidence, sourceList }: EvidenceViewerProps) {
  const review = useReview();
  const target = review.target;
  const focusEntry = target?.evidenceId ? review.evidenceIndex.get(target.evidenceId) : undefined;
  const document = target?.documentId
    ? documents.find((candidate) => candidate.id === target.documentId)
    : undefined;
  const hasSource = Boolean(focusEntry || document);

  if (!hasSource) {
    return <div className="flex flex-col gap-3">{sourceList}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={review.closeSource}
        aria-label="Back to all sources"
      >
        <ArrowLeft aria-hidden />
        All sources
      </Button>
      {document ? (
        <DocumentSource
          key={document.id}
          document={document}
          focusEntry={focusEntry}
          sectionsByEvidence={sectionsByEvidence}
        />
      ) : focusEntry ? (
        <WebSource entry={focusEntry} />
      ) : null}
      {focusEntry && !document && focusEntry.evidence.documentId ? (
        <p className="text-xs text-muted-foreground">
          {getEvidenceLabel(focusEntry.evidence)} is not among this case&apos;s documents.
        </p>
      ) : null}
    </div>
  );
}
