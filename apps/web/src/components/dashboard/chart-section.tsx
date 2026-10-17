"use client";

import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { parseChartSpecContent, type DeliverableSection } from "@evianta/core";
import { ChartView } from "./chart-view";

export interface ChartSectionProps {
  section: DeliverableSection;
  footer?: ReactNode;
  size?: { width: number; height: number };
}

export function ChartSection({ section, footer, size }: ChartSectionProps) {
  const parsed = parseChartSpecContent(section.editedContent ?? section.content);
  if (!parsed.success) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle p-4 text-sm"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          <span className="font-medium">{section.title}</span> could not be drawn: {parsed.error}.
        </p>
      </div>
    );
  }

  return <ChartView spec={parsed.spec} footer={footer} size={size} />;
}
