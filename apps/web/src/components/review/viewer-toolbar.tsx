"use client";

import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export const zoomLevels = [0.75, 1, 1.25, 1.5, 2] as const;

export interface ViewerToolbarProps {
  page?: number;
  pageCount?: number;
  onPageChange?: (page: number) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  label: string;
}

export function ViewerToolbar({
  page,
  pageCount,
  onPageChange,
  zoom,
  onZoomChange,
  label,
}: ViewerToolbarProps) {
  const zoomIndex = zoomLevels.findIndex((level) => level === zoom);
  return (
    <div
      role="toolbar"
      aria-label={`${label} controls`}
      className="flex flex-wrap items-center justify-between gap-2"
    >
      {page !== undefined && onPageChange ? (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span
            className="figures min-w-24 text-center text-xs text-muted-foreground"
            aria-live="polite"
          >
            Page {page}
            {pageCount ? ` of ${pageCount}` : ""}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={pageCount !== undefined && page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoomIndex <= 0}
          onClick={() => onZoomChange(zoomLevels[Math.max(0, zoomIndex - 1)]!)}
        >
          <ZoomOut aria-hidden />
        </Button>
        <span className="figures w-12 text-center text-xs text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoomIndex >= zoomLevels.length - 1}
          onClick={() => onZoomChange(zoomLevels[Math.min(zoomLevels.length - 1, zoomIndex + 1)]!)}
        >
          <ZoomIn aria-hidden />
        </Button>
      </div>
    </div>
  );
}
