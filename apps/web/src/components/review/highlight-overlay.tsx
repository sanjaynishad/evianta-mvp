"use client";

import type { MouseEvent } from "react";
import type { BoundingBox } from "@evianta/core";
import {
  boxCenter,
  boxContainsPoint,
  toPercentStyle,
  unionBoxes,
  type Point,
} from "@/lib/evidence-location";
import { cn } from "@/lib/utils";

export interface OverlayRegion {
  evidenceId: string;
  description: string;
  boxes: BoundingBox[];
  focused: boolean;
  selected: boolean;
  approximate: boolean;
}

export interface HighlightOverlayProps {
  regions: OverlayRegion[];
  // Set when the focused evidence could only be placed on the page, not a region of it.
  pageHighlight?: { approximate: boolean };
  pulseKey: number;
  // Receives the clicked region and every other region under the same point.
  onSelect: (evidenceIds: string[]) => void;
}

export function overlayRegionsAtPoint(regions: OverlayRegion[], point: Point): string[] {
  return regions
    .filter((region) => region.boxes.some((box) => boxContainsPoint(box, point)))
    .map((region) => region.evidenceId);
}

function pointFromEvent(event: MouseEvent<HTMLButtonElement>, fallback: Point): Point {
  const container = event.currentTarget.closest<HTMLElement>('[data-slot="highlight-overlay"]');
  const rect = container?.getBoundingClientRect();
  if (event.detail === 0 || !rect || rect.width <= 0 || rect.height <= 0) {
    return fallback;
  }

  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

export function HighlightOverlay({
  regions,
  pageHighlight,
  pulseKey,
  onSelect,
}: HighlightOverlayProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>, region: OverlayRegion) {
    event.stopPropagation();
    const union = unionBoxes(region.boxes);
    const point = pointFromEvent(event, union ? boxCenter(union) : { x: 0, y: 0 });
    onSelect([...new Set([region.evidenceId, ...overlayRegionsAtPoint(regions, point)])]);
  }

  return (
    <div className="pointer-events-none absolute inset-0" data-slot="highlight-overlay">
      {pageHighlight ? (
        <div
          key={`page-${pulseKey}`}
          data-page-highlight
          className="absolute inset-0 rounded-sm ring-4 ring-inset ring-highlight/60 animate-evidence-pulse motion-reduce:animate-none"
        >
          <span className="absolute left-2 top-2 rounded-full bg-highlight px-2 py-0.5 text-xs font-medium text-highlight-foreground">
            Cited page{pageHighlight.approximate ? ", approximate" : ""}
          </span>
        </div>
      ) : null}
      {regions.map((region) => {
        const union = unionBoxes(region.boxes);
        if (!union) {
          return null;
        }

        return (
          <div key={region.evidenceId}>
            {region.focused && region.boxes.length > 1
              ? region.boxes.map((box, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className="absolute rounded-sm bg-highlight/20"
                    style={toPercentStyle(box)}
                  />
                ))
              : null}
            <button
              key={region.focused ? `focused-${pulseKey}` : "idle"}
              type="button"
              data-evidence-region={region.evidenceId}
              data-focused={region.focused || undefined}
              data-approximate={region.approximate || undefined}
              aria-pressed={region.selected}
              aria-label={`Evidence region: ${region.description}. Show the findings that cite it.`}
              onClick={(event) => handleClick(event, region)}
              style={toPercentStyle(union)}
              className={cn(
                "pointer-events-auto absolute rounded-sm transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                region.focused
                  ? "border-2 border-highlight bg-highlight/15 animate-evidence-pulse motion-reduce:animate-none"
                  : "border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/15",
                region.approximate && region.focused && "border-dashed",
                region.selected && "ring-2 ring-primary ring-offset-1",
              )}
            >
              {region.focused && region.approximate ? (
                <span className="absolute -top-5 left-0 whitespace-nowrap rounded-full bg-highlight px-1.5 text-[11px] font-medium leading-4 text-highlight-foreground">
                  Approximate
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
