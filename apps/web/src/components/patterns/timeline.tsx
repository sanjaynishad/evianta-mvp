"use client";

import type { ReactNode } from "react";
import { Circle, type LucideIcon } from "lucide-react";
import { useAutoAnimateList } from "@/hooks/use-auto-animate-list";
import { formatDate, toIsoDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TimelineTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const markerToneClassNames: Record<TimelineTone, string> = {
  neutral: "border-border bg-background text-muted-foreground",
  primary: "border-primary/30 bg-primary-subtle text-primary",
  success: "border-success/30 bg-success-subtle text-success",
  warning: "border-warning/30 bg-warning-subtle text-warning",
  danger: "border-danger/30 bg-danger-subtle text-danger",
  info: "border-info/30 bg-info-subtle text-info",
};

export interface TimelineItem {
  id: string;
  date: DateInput;
  title: string;
  description?: ReactNode;
  tone?: TimelineTone;
  icon?: LucideIcon;
  meta?: ReactNode;
}

export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
  "aria-label"?: string;
}

export function Timeline({ items, className, "aria-label": ariaLabel }: TimelineProps) {
  const listRef = useAutoAnimateList<HTMLOListElement>();

  return (
    <ol ref={listRef} aria-label={ariaLabel} className={cn("relative flex flex-col", className)}>
      {items.map((item, index) => {
        const Icon = item.icon ?? Circle;
        const isLast = index === items.length - 1;
        return (
          <li key={item.id} className="relative flex gap-4 pb-6 last:pb-0">
            {!isLast ? (
              <span
                aria-hidden
                className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-border"
              />
            ) : null}
            <span
              aria-hidden
              className={cn(
                "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border",
                markerToneClassNames[item.tone ?? "neutral"],
              )}
            >
              <Icon className={cn("size-4", !item.icon && "size-2.5 fill-current")} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <time
                  dateTime={toIsoDate(item.date)}
                  className="figures text-xs text-muted-foreground"
                >
                  {formatDate(item.date)}
                </time>
                <p className="text-sm font-medium text-foreground">{item.title}</p>
              </div>
              {item.description ? (
                <div className="text-sm text-muted-foreground">{item.description}</div>
              ) : null}
              {item.meta ? <div className="flex flex-wrap gap-1.5 pt-1">{item.meta}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
