"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import type { ExtractedDocument } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { ViewerToolbar } from "./viewer-toolbar";

export interface TextSourceViewerProps {
  documentName: string;
  extraction?: ExtractedDocument;
  page: number;
  quote?: string;
  requestId: number;
}

function highlightQuote(text: string, quote: string | undefined) {
  if (!quote) {
    return text;
  }

  const index = text.toLowerCase().indexOf(quote.toLowerCase());
  if (index < 0) {
    return text;
  }

  return (
    <>
      {text.slice(0, index)}
      <mark
        data-quote-highlight
        className="rounded-sm bg-highlight-subtle px-0.5 text-foreground ring-1 ring-highlight/50"
      >
        {text.slice(index, index + quote.length)}
      </mark>
      {text.slice(index + quote.length)}
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
  const pages = extraction?.pages ?? [];
  const [navigation, setNavigation] = useState({ requestId, page: targetPage });
  const page = navigation.requestId === requestId ? navigation.page : targetPage;
  const current = pages.find((candidate) => candidate.index === page) ?? pages[0];
  const [zoom, setZoom] = useState(1);

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
        data-slot="text-source-viewer"
        style={{ fontSize: `${0.75 * zoom}rem` }}
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-card p-3 leading-relaxed"
      >
        {highlightQuote(current.text, quote)}
      </pre>
    </div>
  );
}
