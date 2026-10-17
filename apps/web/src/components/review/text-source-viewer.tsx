"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import type { ExtractedDocument } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import { findQuoteRange } from "@/lib/evidence-location";
import { scrollIntoPane } from "@/lib/scroll";
import { ViewerToolbar } from "./viewer-toolbar";

export interface TextSourceViewerProps {
  documentName: string;
  extraction?: ExtractedDocument;
  page: number;
  quote?: string;
  requestId: number;
}

function highlightQuote(text: string, quote: string | undefined) {
  const range = quote ? findQuoteRange(text, quote) : undefined;
  if (!range) {
    return text;
  }

  return (
    <>
      {text.slice(0, range.start)}
      <mark
        data-quote-highlight
        className="rounded-sm bg-highlight-subtle px-0.5 text-foreground ring-1 ring-highlight/50"
      >
        {text.slice(range.start, range.end)}
      </mark>
      {text.slice(range.end)}
    </>
  );
}

// Shows the extracted text when the original file cannot be rendered in the browser.
export function TextSourceViewer({
  documentName,
  extraction,
  page: targetPage,
  quote,
  requestId,
}: TextSourceViewerProps) {
  const { reduced } = useMotionSafe();
  const scrollRef = useRef<HTMLPreElement>(null);
  const pages = extraction?.pages ?? [];
  const [navigation, setNavigation] = useState({ requestId, page: targetPage });
  const page = navigation.requestId === requestId ? navigation.page : targetPage;
  const current = pages.find((candidate) => candidate.index === page) ?? pages[0];
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const highlight = scrollRef.current?.querySelector<HTMLElement>("[data-quote-highlight]");
    if (highlight) {
      scrollIntoPane(highlight, { block: "center", behavior: reduced ? "auto" : "smooth" });
    }
  }, [requestId, current?.index, current?.text, quote, reduced]);

  if (!current) {
    return (
      <EmptyState
        icon={FileText}
        title="No text was read from this file yet"
        description="The source appears here once reading has finished."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ViewerToolbar
        label={documentName}
        page={current.index}
        pageCount={pages.length}
        onPageChange={(next) => setNavigation({ requestId, page: next })}
        zoom={zoom}
        onZoomChange={setZoom}
      />
      <p className="text-xs text-muted-foreground">
        Extracted text, shown because the original cannot be displayed here.
      </p>
      <pre
        ref={scrollRef}
        data-slot="text-source-viewer"
        style={{ fontSize: `${0.75 * zoom}rem` }}
        className="relative max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-card p-3 leading-relaxed"
      >
        {highlightQuote(current.text, quote)}
      </pre>
    </div>
  );
}
