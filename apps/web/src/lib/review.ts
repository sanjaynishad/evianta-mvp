import type {
  AgentRole,
  CaseState,
  ConfidenceLevel,
  Deliverable,
  DeliverableSection,
  Finding,
  OpenQuestion,
  OpenQuestionSeverity,
  SectionUpdateRequest,
  Task,
} from "@evianta/core";

export const severityOrder: OpenQuestionSeverity[] = ["high", "medium", "low"];

const severityRank: Record<OpenQuestionSeverity, number> = { high: 0, medium: 1, low: 2 };

const verifyPattern = /^\s*verify\b|verify against current law/i;

export function isVerifyFlag(text: string): boolean {
  return verifyPattern.test(text);
}

export function findingNeedsVerification(finding: Finding): boolean {
  return (
    verifyPattern.test(finding.detail ?? "") ||
    finding.openQuestions.some((question) => isVerifyFlag(question.text))
  );
}

export interface OpenQuestionItem {
  question: OpenQuestion;
  finding: Finding;
  verify: boolean;
}

export function collectOpenQuestions(findings: Finding[]): OpenQuestionItem[] {
  return findings.flatMap((finding) =>
    finding.openQuestions.map((question) => ({
      question,
      finding,
      verify: isVerifyFlag(question.text),
    })),
  );
}

export function sortBySeverity(items: OpenQuestionItem[]): OpenQuestionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        severityRank[a.item.question.severity] - severityRank[b.item.question.severity] ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

export function groupBySeverity(
  items: OpenQuestionItem[],
): { severity: OpenQuestionSeverity; items: OpenQuestionItem[] }[] {
  return severityOrder
    .map((severity) => ({
      severity,
      items: items.filter((item) => item.question.severity === severity),
    }))
    .filter((group) => group.items.length > 0);
}

export function unresolvedQuestions(findings: Finding[]): OpenQuestionItem[] {
  return sortBySeverity(
    collectOpenQuestions(findings).filter((item) => item.question.status === "open"),
  );
}

export interface ConfidenceCounts {
  high: number;
  medium: number;
  low: number;
  unassessed: number;
}

export interface SectionReviewCounts {
  total: number;
  approved: number;
  needsChanges: number;
  pending: number;
  edited: number;
}

export interface ApprovalSummary {
  unresolved: OpenQuestionItem[];
  assumptions: { text: string; findingId: string; findingSummary: string }[];
  evidenceConfidence: ConfidenceCounts;
  findingConfidence: ConfidenceCounts;
  sections: SectionReviewCounts;
  verifyCount: number;
}

function countConfidence(levels: (ConfidenceLevel | undefined)[]): ConfidenceCounts {
  const counts: ConfidenceCounts = { high: 0, medium: 0, low: 0, unassessed: 0 };
  for (const level of levels) {
    counts[level ?? "unassessed"] += 1;
  }

  return counts;
}

export function summarizeForApproval(state: CaseState): ApprovalSummary {
  const evidence = new Map<string, ConfidenceLevel | undefined>();
  for (const finding of state.findings) {
    for (const item of finding.evidence) {
      evidence.set(item.id, item.confidence);
    }
  }

  for (const item of state.evidence) {
    if (!evidence.has(item.id)) {
      evidence.set(item.id, item.confidence);
    }
  }

  const seenAssumptions = new Set<string>();
  const assumptions: ApprovalSummary["assumptions"] = [];
  for (const finding of state.findings) {
    for (const text of finding.assumptions) {
      if (!seenAssumptions.has(text)) {
        seenAssumptions.add(text);
        assumptions.push({ text, findingId: finding.id, findingSummary: finding.summary });
      }
    }
  }

  const sections = state.deliverables.flatMap((deliverable) => deliverable.sections);
  const unresolved = unresolvedQuestions(state.findings);
  return {
    unresolved,
    assumptions,
    evidenceConfidence: countConfidence([...evidence.values()]),
    findingConfidence: countConfidence(state.findings.map((finding) => finding.confidence)),
    sections: {
      total: sections.length,
      approved: sections.filter((section) => section.reviewStatus === "approved").length,
      needsChanges: sections.filter((section) => section.reviewStatus === "needs-changes").length,
      pending: sections.filter((section) => section.reviewStatus === "pending").length,
      edited: sections.filter((section) => section.editedContent !== undefined).length,
    },
    verifyCount: unresolved.filter((item) => item.verify).length,
  };
}

export type OutlineGroupId =
  "analysis" | "reconciliation" | "research" | "draft" | "review" | "dashboard";

export const outlineGroupLabels: Record<OutlineGroupId, string> = {
  analysis: "Analysis",
  reconciliation: "Reconciliation",
  research: "Research",
  draft: "Draft",
  review: "Independent review",
  dashboard: "Dashboard",
};

const outlineGroupOrder: OutlineGroupId[] = [
  "analysis",
  "reconciliation",
  "research",
  "draft",
  "review",
  "dashboard",
];

const roleGroups: Record<AgentRole, OutlineGroupId> = {
  coordinator: "analysis",
  "business-data-analyst": "analysis",
  "case-analysis": "analysis",
  "document-analysis": "analysis",
  "evidence-analysis": "analysis",
  reconciliation: "reconciliation",
  "payment-reconciliation": "reconciliation",
  "tax-research": "research",
  "legal-research": "research",
  "response-preparation": "draft",
  "case-preparation": "draft",
  "independent-review": "review",
};

export function outlineGroupFor(section: DeliverableSection): OutlineGroupId {
  return section.kind === "chart" ? "dashboard" : roleGroups[section.producedByRole];
}

export interface OutlineSection {
  section: DeliverableSection;
  deliverableId: string;
}

export type OutlineTask = Pick<Task, "id" | "title" | "assignedRole" | "status" | "costEstimate">;

export interface OutlineGroup {
  id: OutlineGroupId;
  label: string;
  sections: OutlineSection[];
  tasks: OutlineTask[];
}

export function buildOutline(deliverables: Deliverable[], tasks: OutlineTask[]): OutlineGroup[] {
  const groups = new Map<OutlineGroupId, OutlineGroup>(
    outlineGroupOrder.map((id) => [
      id,
      { id, label: outlineGroupLabels[id], sections: [], tasks: [] },
    ]),
  );
  for (const deliverable of deliverables) {
    for (const section of deliverable.sections) {
      groups.get(outlineGroupFor(section))?.sections.push({
        section,
        deliverableId: deliverable.id,
      });
    }
  }

  for (const task of tasks) {
    if (task.assignedRole !== "coordinator") {
      groups.get(roleGroups[task.assignedRole])?.tasks.push(task);
    }
  }

  return outlineGroupOrder
    .map((id) => groups.get(id))
    .filter(
      (group): group is OutlineGroup =>
        group !== undefined && (group.sections.length > 0 || group.tasks.length > 0),
    );
}

export function sectionDomId(sectionId: string): string {
  return `section-${sectionId}`;
}

export function applySectionUpdate(
  section: DeliverableSection,
  update: SectionUpdateRequest,
  at: string,
): DeliverableSection {
  const next: DeliverableSection = { ...section };
  if (update.editedContent !== undefined) {
    next.editedContent = update.editedContent ?? undefined;
    next.editedAt = update.editedContent === null ? undefined : at;
  }

  if (update.reviewStatus) {
    next.reviewStatus = update.reviewStatus;
    next.reviewedAt = at;
  }

  if (update.reviewComment !== undefined) {
    next.reviewComment = update.reviewComment ?? undefined;
  }

  return next;
}

export function applyQuestionStatus(
  question: OpenQuestion,
  status: "resolved" | "dismissed",
  note: string | undefined,
  at: string,
): OpenQuestion {
  return { ...question, status, resolutionNote: note, resolvedAt: at };
}

export function applyQuestionUpdate(
  finding: Finding,
  questionId: string,
  status: "resolved" | "dismissed",
  note: string | undefined,
  at: string,
): Finding {
  return {
    ...finding,
    openQuestions: finding.openQuestions.map((question) =>
      question.id === questionId ? applyQuestionStatus(question, status, note, at) : question,
    ),
  };
}

export function findingDomId(findingId: string): string {
  return `finding-${findingId}`;
}

export const openQuestionsDomId = "open-questions";

export const findingsDomId = "findings";
