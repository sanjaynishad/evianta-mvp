import {
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import type { ConfidenceLevel } from "@evianta/core";
import { cn } from "@/lib/utils";

export type { ConfidenceLevel } from "@evianta/core";

interface ConfidenceMeta {
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  className: string;
}

export const confidenceMeta: Record<ConfidenceLevel, ConfidenceMeta> = {
  high: {
    label: "High confidence",
    shortLabel: "High",
    icon: ShieldCheck,
    className: "border-confidence-high/25 bg-confidence-high-subtle text-confidence-high",
  },
  medium: {
    label: "Medium confidence",
    shortLabel: "Medium",
    icon: ShieldHalf,
    className: "border-confidence-medium/25 bg-confidence-medium-subtle text-confidence-medium",
  },
  low: {
    label: "Low confidence",
    shortLabel: "Low",
    icon: ShieldAlert,
    className: "border-confidence-low/25 bg-confidence-low-subtle text-confidence-low",
  },
  unassessed: {
    label: "Not assessed",
    shortLabel: "Not assessed",
    icon: ShieldQuestion,
    className:
      "border-dashed border-confidence-unassessed/40 bg-confidence-unassessed-subtle text-confidence-unassessed",
  },
};

export interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  compact?: boolean;
  className?: string;
}

export function ConfidenceBadge({ level, compact = false, className }: ConfidenceBadgeProps) {
  const meta = confidenceMeta[level];
  const Icon = meta.icon;
  return (
    <span
      data-confidence={level}
      title={`Evidence confidence: ${meta.shortLabel}`}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {compact ? (
        <>
          <span className="sr-only">Evidence confidence: </span>
          {meta.shortLabel}
        </>
      ) : (
        meta.label
      )}
    </span>
  );
}
