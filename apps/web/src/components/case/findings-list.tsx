import { CircleHelp, Lightbulb } from "lucide-react";
import type { Finding, OpenQuestion } from "@evianta/core";
import { ConfidenceBadge } from "@/components/patterns/confidence-badge";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { EvidenceEntry } from "@/lib/evidence";
import { findingSeverityLabels } from "@/lib/labels";
import { EvidenceChipList } from "./evidence-chip-list";

export interface FindingsListProps {
  findings: Finding[];
  evidenceIndex: Map<string, EvidenceEntry>;
  onOpenEvidence: (evidenceId: string) => void;
}

const severityVariants: Record<string, NonNullable<BadgeProps["variant"]>> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "info",
};

const questionStatusLabels: Record<OpenQuestion["status"], string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export function FindingsList({ findings, evidenceIndex, onOpenEvidence }: FindingsListProps) {
  return (
    <section aria-labelledby="findings-heading" className="flex flex-col gap-3 print:hidden">
      <h2 id="findings-heading" className="text-base font-semibold">
        Findings and evidence
      </h2>
      {findings.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No findings yet"
          description="Findings appear here as specialists complete their steps."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {findings.map((finding) => (
            <li
              key={finding.id}
              data-finding-id={finding.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-elevation-1"
            >
              <div className="flex flex-wrap items-start gap-2">
                <h3 className="min-w-0 flex-1 text-sm font-semibold">{finding.summary}</h3>
                {finding.severity ? (
                  <Badge variant={severityVariants[finding.severity]}>
                    {findingSeverityLabels[finding.severity]}
                  </Badge>
                ) : null}
                <ConfidenceBadge level={finding.confidence ?? "unassessed"} compact />
              </div>
              {finding.detail ? (
                <p className="text-sm text-muted-foreground">{finding.detail}</p>
              ) : null}
              <EvidenceChipList
                evidenceIds={finding.evidence.map((evidence) => evidence.id)}
                evidenceIndex={evidenceIndex}
                onOpenEvidence={onOpenEvidence}
                label={`Evidence for ${finding.summary}`}
              />
              {finding.evidence.length === 0 ? (
                <p className="text-xs text-warning">No evidence attached to this finding.</p>
              ) : null}
              {finding.assumptions.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Assumptions
                  </p>
                  <ul className="list-disc pl-5 text-sm">
                    {finding.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {finding.openQuestions.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Open questions
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {finding.openQuestions.map((question) => (
                      <li key={question.id} className="flex items-start gap-2 text-sm">
                        <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1">{question.text}</span>
                        <Badge variant={severityVariants[question.severity]}>
                          {findingSeverityLabels[question.severity]}
                        </Badge>
                        {question.status !== "open" ? (
                          <Badge variant="success">{questionStatusLabels[question.status]}</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
