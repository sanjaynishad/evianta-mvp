"use client";

import { useState } from "react";
import type {
  CaseState,
  DeliverableSection,
  OpenQuestion,
  SectionUpdateRequest,
} from "@evianta/core";
import { toast } from "@/components/ui/sonner";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { describeError, isSampleReadOnlyError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { applyQuestionStatus, applySectionUpdate, unresolvedQuestions } from "@/lib/review";

export interface ReviewActionsOptions {
  caseId: string;
  state: CaseState | undefined;
  mutate: (update: (current: CaseState) => CaseState) => void;
  onTryCase?: () => void;
  now?: () => Date;
}

export interface ReviewActions {
  isPending: (key: string) => boolean;
  updateSectionAsync: (
    deliverableId: string,
    sectionId: string,
    update: SectionUpdateRequest,
  ) => Promise<boolean>;
  resolveQuestionAsync: (questionId: string, note?: string) => Promise<boolean>;
  dismissQuestionAsync: (questionId: string, note?: string) => Promise<boolean>;
  approveAsync: (note?: string) => Promise<boolean>;
}

export const sectionActionKey = (sectionId: string) => `section:${sectionId}`;
export const questionActionKey = (questionId: string) => `question:${questionId}`;
export const approveActionKey = "approve";

function replaceSection(
  state: CaseState,
  deliverableId: string,
  sectionId: string,
  replace: (section: DeliverableSection) => DeliverableSection,
): CaseState {
  return {
    ...state,
    deliverables: state.deliverables.map((deliverable) =>
      deliverable.id === deliverableId
        ? {
            ...deliverable,
            sections: deliverable.sections.map((section) =>
              section.id === sectionId ? replace(section) : section,
            ),
          }
        : deliverable,
    ),
  };
}

function replaceQuestion(
  state: CaseState,
  questionId: string,
  replace: (question: OpenQuestion) => OpenQuestion,
): CaseState {
  return {
    ...state,
    findings: state.findings.map((finding) =>
      finding.openQuestions.some((question) => question.id === questionId)
        ? {
            ...finding,
            openQuestions: finding.openQuestions.map((question) =>
              question.id === questionId ? replace(question) : question,
            ),
          }
        : finding,
    ),
  };
}

function findSection(
  state: CaseState,
  deliverableId: string,
  sectionId: string,
): DeliverableSection | undefined {
  return state.deliverables
    .find((deliverable) => deliverable.id === deliverableId)
    ?.sections.find((section) => section.id === sectionId);
}

function findQuestion(state: CaseState, questionId: string): OpenQuestion | undefined {
  for (const finding of state.findings) {
    const question = finding.openQuestions.find((candidate) => candidate.id === questionId);
    if (question) {
      return question;
    }
  }

  return undefined;
}

function cleanNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed ? trimmed : undefined;
}

// Applies review actions to the local case state at once, then reconciles the touched item with
// the server's copy, or rolls it back when the request fails.
export function useReviewActions({
  caseId,
  state,
  mutate,
  onTryCase,
  now = () => new Date(),
}: ReviewActionsOptions): ReviewActions {
  const dataSource = useDataSource();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  function setKey(key: string, active: boolean) {
    setPending((current) => {
      const next = new Set(current);
      if (active) {
        next.add(key);
      } else {
        next.delete(key);
      }

      return next;
    });
  }

  function reportFailure(title: string, error: unknown) {
    if (isSampleReadOnlyError(error)) {
      toast.info("Sample cases are read-only", {
        description: "Try this case to review and edit your own copy.",
        action: onTryCase ? { label: "Try this case", onClick: onTryCase } : undefined,
      });
      return;
    }

    toast.error(title, { description: `${describeError(error)} Your change was undone.` });
  }

  const updateSectionAsync = useLatestCallback(
    async (deliverableId: string, sectionId: string, update: SectionUpdateRequest) => {
      const previous = state ? findSection(state, deliverableId, sectionId) : undefined;
      if (!previous) {
        return false;
      }

      const optimistic = applySectionUpdate(previous, update, now().toISOString());
      const key = sectionActionKey(sectionId);
      mutate((current) => replaceSection(current, deliverableId, sectionId, () => optimistic));
      setKey(key, true);
      try {
        const saved = await dataSource.updateSectionAsync(caseId, deliverableId, sectionId, update);
        const savedSection = saved.sections.find((section) => section.id === sectionId);
        if (savedSection) {
          mutate((current) =>
            replaceSection(current, deliverableId, sectionId, (section) =>
              section === optimistic ? savedSection : section,
            ),
          );
        }

        return true;
      } catch (error) {
        mutate((current) =>
          replaceSection(current, deliverableId, sectionId, (section) =>
            section === optimistic ? previous : section,
          ),
        );
        reportFailure("The section change was not saved", error);
        return false;
      } finally {
        setKey(key, false);
      }
    },
  );

  async function updateQuestionAsync(
    questionId: string,
    status: "resolved" | "dismissed",
    note: string | undefined,
  ): Promise<boolean> {
    const previous = state ? findQuestion(state, questionId) : undefined;
    if (!previous) {
      return false;
    }

    const cleaned = cleanNote(note);
    const optimistic = applyQuestionStatus(previous, status, cleaned, now().toISOString());
    const key = questionActionKey(questionId);
    mutate((current) => replaceQuestion(current, questionId, () => optimistic));
    setKey(key, true);
    try {
      const finding =
        status === "resolved"
          ? await dataSource.resolveOpenQuestionAsync(caseId, questionId, cleaned)
          : await dataSource.dismissOpenQuestionAsync(caseId, questionId, cleaned);
      const saved = finding.openQuestions.find((question) => question.id === questionId);
      if (saved) {
        mutate((current) =>
          replaceQuestion(current, questionId, (question) =>
            question === optimistic ? saved : question,
          ),
        );
      }

      return true;
    } catch (error) {
      mutate((current) =>
        replaceQuestion(current, questionId, (question) =>
          question === optimistic ? previous : question,
        ),
      );
      reportFailure(
        status === "resolved" ? "The question was not resolved" : "The question was not dismissed",
        error,
      );
      return false;
    } finally {
      setKey(key, false);
    }
  }

  const resolveQuestionAsync = useLatestCallback((questionId: string, note?: string) =>
    updateQuestionAsync(questionId, "resolved", note),
  );

  const dismissQuestionAsync = useLatestCallback((questionId: string, note?: string) =>
    updateQuestionAsync(questionId, "dismissed", note),
  );

  const approveAsync = useLatestCallback(async (note?: string) => {
    if (!state) {
      return false;
    }

    const previousApproval = state.case.approval;
    const cleaned = cleanNote(note);
    const optimisticApproval = {
      approvedAt: now().toISOString(),
      unresolvedQuestionIds: unresolvedQuestions(state.findings).map((item) => item.question.id),
      note: cleaned,
    };
    // Only the approval field is guarded, so other updates to the case (such as refreshed usage)
    // that land while the request is pending are kept.
    mutate((current) => ({ ...current, case: { ...current.case, approval: optimisticApproval } }));
    setKey(approveActionKey, true);
    try {
      const response = await dataSource.approveCaseAsync(caseId, cleaned);
      mutate((current) =>
        current.case.approval === optimisticApproval
          ? {
              ...current,
              case: {
                ...current.case,
                approval: response.case.approval,
                status: response.case.status,
                updatedAt: response.case.updatedAt,
              },
            }
          : current,
      );
      return true;
    } catch (error) {
      mutate((current) =>
        current.case.approval === optimisticApproval
          ? { ...current, case: { ...current.case, approval: previousApproval } }
          : current,
      );
      reportFailure("The case was not approved", error);
      return false;
    } finally {
      setKey(approveActionKey, false);
    }
  });

  return {
    isPending: (key) => pending.has(key),
    updateSectionAsync,
    resolveQuestionAsync,
    dismissQuestionAsync,
    approveAsync,
  };
}
