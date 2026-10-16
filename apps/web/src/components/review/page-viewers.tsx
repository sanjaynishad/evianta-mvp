"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import dynamic from "next/dynamic";
import { FileWarning } from "lucide-react";
import type { BoundingBox, CaseDocument, ExtractedDocument } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useElementWidth } from "@/hooks/use-element-width";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import type { EvidenceEntry } from "@/lib/evidence";
import { regionForEntry, regionsForPage, type EvidenceRegion } from "@/lib/evidence-regions";
import { scrollIntoPane } from "@/lib/scroll";
import { findQuoteInTextLayer } from "@/lib/text-layer";
import { HighlightOverlay, type OverlayRegion } from "./highlight-overlay";
import { ViewerToolbar } from "./viewer-toolbar";

const PdfPageView = dynamic(() => import("./pdf-page-view"), {
  ssr: false,
  loading: () => <Skeleton className="mx-auto aspect-[1/1.414] w-full max-w-xl" />,
});

export interface PageViewerProps {
  document: CaseDocument;
  extraction?: ExtractedDocument;
  fileUrl: string;
  entries: EvidenceEntry[];
  focusEvidenceId?: string;
  requestId: number;
  selectedEvidenceIds: string[];
  onSelectRegions: (evidenceIds: string[], label: string) => void;
}

interface PageRegionsResult {
  overlayRegions: OverlayRegion[];
  pageHighlight?: { approximate: boolean };
  focusedRegion?: EvidenceRegion;
}

function buildPageRegions(
  pageRegions: EvidenceRegion[],
  focusEvidenceId: string | undefined,
  selectedEvidenceIds: string[],
  fallbackBoxes: BoundingBox[] | undefined,
): PageRegionsResult {
  const focusedRegion = pageRegions.find((region) => region.evidenceId === focusEvidenceId);
  const overlayRegions = pageRegions
    .map((region) => {
      const focused = region.evidenceId === focusEvidenceId;
      const boxes =
        focused && region.highlight.boxes.length === 0 && fallbackBoxes
          ? fallbackBoxes
          : region.highlight.boxes;
      return {
        evidenceId: region.evidenceId,
        description: region.description,
        boxes,
        focused,
        selected: selectedEvidenceIds.includes(region.evidenceId),
        approximate: region.highlight.approximate,
      };
    })
    .filter((region) => region.boxes.length > 0);
  const focusedPlaced = overlayRegions.some((region) => region.focused);
  return {
    overlayRegions,
    focusedRegion,
    pageHighlight:
      focusedRegion && !focusedPlaced
        ? { approximate: focusedRegion.highlight.approximate }
        : undefined,
  };
}

function useScrollToFocus(
  containerRef: RefObject<HTMLElement | null>,
  scrollKey: string,
  ready: boolean,
) {
  const { reduced } = useMotionSafe();
  useEffect(() => {
    if (!ready) {
      return;
    }

    const target = containerRef.current?.querySelector<HTMLElement>(
      "[data-evidence-region][data-focused], [data-page-highlight]",
    );
    if (target) {
      scrollIntoPane(target, { block: "center", behavior: reduced ? "auto" : "smooth" });
    }
  }, [containerRef, scrollKey, ready, reduced]);
}

// Page navigation that jumps to the evidence page whenever a new evidence request arrives.
function usePageNavigation(requestId: number, targetPage: number) {
  const [state, setState] = useState({ requestId, page: targetPage });
  const page = state.requestId === requestId ? state.page : targetPage;
  return [page, (next: number) => setState({ requestId, page: next })] as const;
}

function selectionLabel(document: CaseDocument, page: number, pageCount?: number): string {
  return pageCount && pageCount > 1 ? `${document.name}, page ${page}` : document.name;
}

function ViewerError({ title, description }: { title: string; description: string }) {
  return <EmptyState icon={FileWarning} title={title} description={description} />;
}

export function PdfViewer({
  document,
  extraction,
  fileUrl,
  entries,
  focusEvidenceId,
  requestId,
  selectedEvidenceIds,
  onSelectRegions,
}: PageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(containerRef);
  const [pageCount, setPageCount] = useState<number>();
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<Error>();
  const [textLayerMatch, setTextLayerMatch] = useState<{ key: string; boxes?: BoundingBox[] }>();
  const [renderCount, setRenderCount] = useState(0);
  const knownPageCount = pageCount ?? (extraction?.pages.length || undefined);
  const focusEntry = entries.find((entry) => entry.evidence.id === focusEvidenceId);
  const focusPage = focusEntry
    ? regionForEntry(focusEntry, extraction, knownPageCount).highlight.page
    : 1;
  const [page, setPage] = usePageNavigation(requestId, focusPage);
  const pageRegions = regionsForPage(entries, extraction, page, knownPageCount);
  const matchKey = `${requestId}:${page}:${zoom}`;
  const { overlayRegions, pageHighlight, focusedRegion } = buildPageRegions(
    pageRegions,
    focusEvidenceId,
    selectedEvidenceIds,
    textLayerMatch?.key === matchKey ? textLayerMatch.boxes : undefined,
  );
  const quote = focusEntry?.evidence.location?.textQuote;
  const needsTextLayer = Boolean(
    focusedRegion && focusedRegion.highlight.source === "page" && quote,
  );
  const pageWidth = Math.max(240, Math.round(((width ?? 560) - 16) * zoom));

  useScrollToFocus(
    containerRef,
    `${requestId}:${renderCount}:${textLayerMatch?.key ?? ""}`,
    overlayRegions.length > 0 || Boolean(pageHighlight),
  );

  if (error) {
    return (
      <ViewerError
        title="The PDF could not be shown"
        description="Use View original to open the file, or check the extracted text."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ViewerToolbar
        label={document.name}
        page={page}
        pageCount={knownPageCount}
        onPageChange={setPage}
        zoom={zoom}
        onZoomChange={setZoom}
      />
      <div
        ref={containerRef}
        data-slot="pdf-viewer"
        className="relative overflow-auto rounded-md border bg-muted/40 p-2"
      >
        <PdfPageView
          fileUrl={fileUrl}
          pageNumber={page}
          width={pageWidth}
          onDocumentLoad={setPageCount}
          onError={setError}
          onPageRender={() => setRenderCount((count) => count + 1)}
          onTextLayerReady={(pageElement) => {
            if (needsTextLayer && quote && textLayerMatch?.key !== matchKey) {
              setTextLayerMatch({ key: matchKey, boxes: findQuoteInTextLayer(pageElement, quote) });
            }
          }}
          overlay={
            <HighlightOverlay
              regions={overlayRegions}
              pageHighlight={pageHighlight}
              pulseKey={requestId}
              onSelect={(evidenceIds) =>
                onSelectRegions(evidenceIds, selectionLabel(document, page, knownPageCount))
              }
            />
          }
        />
      </div>
    </div>
  );
}

export interface ImageViewerProps extends PageViewerProps {
  alt: string;
}

export function ImageViewer({
  document,
  extraction,
  fileUrl,
  entries,
  focusEvidenceId,
  requestId,
  selectedEvidenceIds,
  onSelectRegions,
  alt,
}: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pageRegions = regionsForPage(entries, extraction, 1, 1);
  const { overlayRegions, pageHighlight } = buildPageRegions(
    pageRegions,
    focusEvidenceId,
    selectedEvidenceIds,
    undefined,
  );

  useScrollToFocus(
    containerRef,
    `${requestId}:${loaded}`,
    loaded && (overlayRegions.length > 0 || Boolean(pageHighlight)),
  );

  if (failed) {
    return (
      <ViewerError
        title="The image could not be shown"
        description="Use View original to open the file."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ViewerToolbar label={document.name} zoom={zoom} onZoomChange={setZoom} />
      <div
        ref={containerRef}
        data-slot="image-viewer"
        className="relative overflow-auto rounded-md border bg-muted/40 p-2"
      >
        <div className="relative mx-auto" style={{ width: `${zoom * 100}%` }}>
          <img
            src={fileUrl}
            alt={alt}
            className="block h-auto w-full"
            onError={() => setFailed(true)}
            onLoad={() => setLoaded(true)}
          />
          <HighlightOverlay
            regions={overlayRegions}
            pageHighlight={pageHighlight}
            pulseKey={requestId}
            onSelect={(evidenceIds) => onSelectRegions(evidenceIds, document.name)}
          />
        </div>
      </div>
    </div>
  );
}
