import { useState, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApproveCaseResponse, CaseState } from "@evianta/core";
import { getSampleStateForUseCase } from "@/fixtures";
import { ApiError } from "@/lib/api/errors";
import { DataSourceProvider } from "@/lib/data/data-source-context";
import type { CaseDataSource } from "@/lib/data/types";
import { createTestDataSource } from "@/test/render-with-data";
import { useReviewActions } from "./use-review-actions";

function approvedCase(): CaseState {
  const state = structuredClone(getSampleStateForUseCase("tax-notice"));
  state.case.isSample = false;
  state.case.approval = {
    approvedAt: "2026-10-16T09:00:00.000Z",
    unresolvedQuestionIds: [],
  };
  return state;
}

function renderActions(initial: CaseState, dataSource: CaseDataSource) {
  return renderHook(
    () => {
      const [state, mutate] = useState(initial);
      const actions = useReviewActions({ caseId: initial.case.id, state, mutate });
      return { state, actions };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DataSourceProvider dataSource={dataSource}>{children}</DataSourceProvider>
      ),
    },
  );
}

describe("review approval invalidation", () => {
  it.each(["Reviewer text", null])(
    "clears local approval after a successful content update to %s",
    async (editedContent) => {
      const initial = approvedCase();
      const dataSource = createTestDataSource({ seedStates: [initial] });
      const { result } = renderActions(initial, dataSource);

      await act(async () => {
        expect(
          await result.current.actions.updateSectionAsync("b-deliverable-pack", "b-section-draft", {
            editedContent,
          }),
        ).toBe(true);
      });

      expect(result.current.state.case.approval).toBeUndefined();
    },
  );

  it("preserves approval for review-only updates and failed content edits", async () => {
    const initial = approvedCase();
    const dataSource = createTestDataSource({ seedStates: [initial] });
    const { result } = renderActions(initial, dataSource);

    await act(async () => {
      await result.current.actions.updateSectionAsync("b-deliverable-pack", "b-section-draft", {
        reviewStatus: "approved",
      });
    });
    expect(result.current.state.case.approval).toEqual(initial.case.approval);

    vi.spyOn(dataSource, "updateSectionAsync").mockRejectedValue(
      new ApiError("The server is busy.", 503),
    );
    await act(async () => {
      expect(
        await result.current.actions.updateSectionAsync("b-deliverable-pack", "b-section-draft", {
          editedContent: "Unsaved text",
        }),
      ).toBe(false);
    });
    expect(result.current.state.case.approval).toEqual(initial.case.approval);
    expect(
      result.current.state.deliverables
        .find((deliverable) => deliverable.id === "b-deliverable-pack")
        ?.sections.find((section) => section.id === "b-section-draft")?.editedContent,
    ).toBeUndefined();
  });

  it.each([true, false])(
    "does not restore stale approval when an earlier approval request settles with success=%s",
    async (succeeds) => {
      const initial = approvedCase();
      const dataSource = createTestDataSource({ seedStates: [initial] });
      let settle!: (response: ApproveCaseResponse) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(dataSource, "approveCaseAsync").mockImplementation(
        () =>
          new Promise<ApproveCaseResponse>((resolve, rejectPromise) => {
            settle = resolve;
            reject = rejectPromise;
          }),
      );
      const { result } = renderActions(initial, dataSource);
      let approving!: Promise<boolean>;
      act(() => {
        approving = result.current.actions.approveAsync();
      });
      expect(result.current.state.case.approval).toBeDefined();

      await act(async () => {
        await result.current.actions.updateSectionAsync("b-deliverable-pack", "b-section-draft", {
          editedContent: "New content after approval began",
        });
      });
      expect(result.current.state.case.approval).toBeUndefined();

      await act(async () => {
        if (succeeds) {
          settle({ case: initial.case, unresolvedQuestions: [] });
        } else {
          reject(new ApiError("The server is busy.", 503));
        }

        await approving;
      });
      expect(result.current.state.case.approval).toBeUndefined();
    },
  );
});
