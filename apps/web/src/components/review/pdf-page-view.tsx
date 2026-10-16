"use client";

import { useRef, type ReactNode } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { Skeleton } from "@/components/ui/skeleton";

// The worker must be configured in the module that renders react-pdf components.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export interface PdfPageViewProps {
  fileUrl: string;
  pageNumber: number;
  width: number;
  onDocumentLoad: (pageCount: number) => void;
  onError: (error: Error) => void;
  onTextLayerReady?: (page: HTMLElement) => void;
  overlay?: ReactNode;
}

function PageSkeleton({ width }: { width: number }) {
  return <Skeleton style={{ width, height: Math.round(width * 1.414) }} className="mx-auto" />;
}

export default function PdfPageView({
  fileUrl,
  pageNumber,
  width,
  onDocumentLoad,
  onError,
  onTextLayerReady,
  overlay,
}: PdfPageViewProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  return (
    <Document
      file={fileUrl}
      onLoadSuccess={(document) => onDocumentLoad(document.numPages)}
      onLoadError={onError}
      onSourceError={onError}
      loading={<PageSkeleton width={width} />}
      error={<span className="sr-only">The PDF could not be loaded.</span>}
    >
      <div
        ref={pageRef}
        data-pdf-page={pageNumber}
        className="relative mx-auto w-fit bg-white shadow-elevation-2"
      >
        <Page
          pageNumber={pageNumber}
          width={width}
          renderAnnotationLayer={false}
          renderTextLayer
          loading={<PageSkeleton width={width} />}
          onRenderTextLayerSuccess={() => {
            if (pageRef.current) {
              onTextLayerReady?.(pageRef.current);
            }
          }}
          onLoadError={onError}
        />
        {overlay}
      </div>
    </Document>
  );
}
