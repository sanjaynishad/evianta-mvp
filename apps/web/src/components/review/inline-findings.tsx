"use client";

import { ShieldAlert } from "lucide-react";
import type { Finding } from "@evianta/core";
import { EvidenceChipList } from "@/components/case/evidence-chip-list";
import { ConfidenceBadge } from "@/components/patterns/confidence-badge";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { EvidenceEntry } from "@/lib/evidence";
import { findingSeverityLabels } from "@/lib/labels";
import { findingNeedsVerification } from "@/lib/review";

export const severityBadgeVariants: Record<string, NonNullable<BadgeProps["variant"]>> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "info",
};

export function VerifyFlagBadge() {
  return (
    <Badge variant="warning" data-verify-flag>
      <ShieldAlert aria-hidden />
      Verify before relying on it
    </Badge>
  );
}

export interface InlineFindingsProps {
  findings: Finding[];
  evidenceIndex: Map<string, EvidenceEntry>;
  onOpenEvidence: (evidenceId: string) => void;
  onFocusFinding?: (findingId: string) => void;
  label: string;
}

export function InlineFindings({
  findings,
  evidenceIndex,
  onOpenEvidence,
  onFocusFinding,
  label,
}: InlineFindingsProps) {
  if (findings.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 print:hidden">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Supporting findings
      </p>
      <ul aria-label={label} className="flex flex-col gap-2">
        {findings.map((finding) => (
          <li
            key={finding.id}
            data-inline-finding={finding.id}
            className="flex flex-col gap-2 rounded-md border border-dashed bg-background p-2.5"
          >
            <div className="flex flex-wrap items-start gap-2">
              {onFocusFinding ? (
                <button
                  type="button"
                  onClick={() => onFocusFinding(finding.id)}
                  className="min-w-0 flex-1 rounded-sm text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {finding.summary}
                </button>
              ) : (
                <span className="min-w-0 flex-1 text-sm font-medium">{finding.summary}</span>
              )}
              {finding.severity ? (
                <Badge variant={severityBadgeVariants[finding.severity]}>
                  {findingSeverityLabels[finding.severity]}
                </Badge>
              ) : null}
              <ConfidenceBadge level={finding.confidence ?? "unassessed"} compact />
              {findingNeedsVerification(finding) ? <VerifyFlagBadge /> : null}
            </div>
            <EvidenceChipList
              evidenceIds={finding.evidence.map((evidence) => evidence.id)}
              evidenceIndex={evidenceIndex}
              onOpenEvidence={onOpenEvidence}
              label={`Evidence for ${finding.summary}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
