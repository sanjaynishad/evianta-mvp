"use client";

import type { ReactNode } from "react";
import { FileSearch } from "lucide-react";
import { ConfidenceBadge } from "@/components/patterns/confidence-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatEvidenceLocator, getEvidenceLabel, type EvidenceEntry } from "@/lib/evidence";
import { importedFromLabel } from "@/lib/sources";

export interface EvidenceDrawerProps {
  entry: EvidenceEntry | undefined;
  findingTitles: Map<string, string>;
  onOpenChange: (open: boolean) => void;
}

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function EvidenceDrawer({ entry, findingTitles, onOpenChange }: EvidenceDrawerProps) {
  const evidence = entry?.evidence;
  const locator = formatEvidenceLocator(evidence?.location);
  const isWebSource = evidence ? /^https?:\/\//i.test(evidence.sourceRef) : false;

  return (
    <Sheet open={Boolean(entry)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-5 overflow-y-auto overscroll-contain sm:max-w-md"
      >
        {evidence && entry ? (
          <>
            <SheetHeader>
              <SheetTitle>{evidence.description}</SheetTitle>
              <SheetDescription>{getEvidenceLabel(evidence, entry.document)}</SheetDescription>
            </SheetHeader>
            <dl className="flex flex-col gap-4 px-5">
              <DetailRow term="Source">
                {isWebSource ? (
                  <a
                    href={evidence.sourceRef}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {evidence.sourceRef}
                  </a>
                ) : (
                  (entry.document?.name ?? evidence.sourceRef)
                )}
              </DetailRow>
              {entry.document?.provenance ? (
                <DetailRow term="Imported from">
                  {importedFromLabel(entry.document.provenance)}
                </DetailRow>
              ) : null}
              {locator ? (
                <DetailRow term="Location">
                  <span className="figures">{locator}</span>
                </DetailRow>
              ) : null}
              {evidence.location?.textQuote || evidence.excerpt ? (
                <DetailRow term="Quoted text">
                  <blockquote className="border-l-2 border-highlight pl-3 text-foreground">
                    {evidence.location?.textQuote ?? evidence.excerpt}
                  </blockquote>
                </DetailRow>
              ) : null}
              {evidence.excerpt && evidence.location?.textQuote ? (
                <DetailRow term="Excerpt">{evidence.excerpt}</DetailRow>
              ) : null}
              <DetailRow term="Confidence">
                <ConfidenceBadge level={evidence.confidence ?? "unassessed"} />
              </DetailRow>
              {entry.findingIds.length > 0 ? (
                <DetailRow term="Supports">
                  <ul className="list-disc pl-5">
                    {entry.findingIds.map((findingId) => (
                      <li key={findingId}>{findingTitles.get(findingId) ?? findingId}</li>
                    ))}
                  </ul>
                </DetailRow>
              ) : null}
            </dl>
            <p className="mx-5 flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <FileSearch aria-hidden className="size-4 shrink-0" />
              The source viewer with highlights on the page or cells is coming next. For now this
              panel shows where the evidence sits in the source.
            </p>
          </>
        ) : (
          <SheetTitle className="sr-only">Evidence</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}
