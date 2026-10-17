import { useEffect, type ReactNode } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResult, CaseState } from "@evianta/core";
import { CaseWorkspace } from "@/components/case/case-workspace";
import { sampleCaseStates } from "@/fixtures";
import { lineBox, sourceLayouts } from "@/fixtures/source-layouts";
import { ApiError } from "@/lib/api/errors";
import { stubMatchMedia } from "@/test/match-media";
import {
  createTestDataSource,
  renderWithDataSource,
  stubResizeObserver,
  testVisitorId,
} from "@/test/render-with-data";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/cases/test",
}));

let currentPdf = "";

function layoutForFile(file: string) {
  return sourceLayouts.find((layout) => file.endsWith(encodeURIComponent(layout.fileName)));
}

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    file,
    onLoadSuccess,
    children,
  }: {
    file: string;
    onLoadSuccess?: (document: { numPages: number }) => void;
    children: ReactNode;
  }) => {
    currentPdf = file;
    const pageCount = layoutForFile(file)?.pages.length ?? 1;
    useEffect(() => {
      onLoadSuccess?.({ numPages: pageCount });
    }, [onLoadSuccess, pageCount]);
    return (
      <div data-testid="pdf-document" data-file={file}>
        {children}
      </div>
    );
  },
  Page: ({
    pageNumber,
    onRenderTextLayerSuccess,
  }: {
    pageNumber: number;
    onRenderTextLayerSuccess?: () => void;
  }) => {
    const lines = layoutForFile(currentPdf)?.pages[pageNumber - 1]?.lines ?? [];
    useEffect(() => {
      onRenderTextLayerSuccess?.();
    }, [onRenderTextLayerSuccess, pageNumber]);
    return (
      <div data-testid="pdf-page" data-page-number={pageNumber}>
        <div className="textLayer">
          {lines.map((line, index) => {
            const box = lineBox(line);
            return (
              <span key={index} data-rect={`${box.x},${box.y},${box.width},${box.height}`}>
                {line.text}
              </span>
            );
          })}
        </div>
      </div>
    );
  },
}));

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const timeout = 30000;
const slow = { timeout: 10000 };

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeAll(() => {
  stubResizeObserver();
  stubMatchMedia(true, { viewportWidth: 1440 });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const stored = this.getAttribute("data-rect");
    if (stored) {
      const [x, y, width, height] = stored.split(",").map((value) => Number(value) * 1000);
      return rect(x!, y!, width!, height!);
    }

    if (this.hasAttribute("data-pdf-page")) {
      return rect(0, 0, 1000, 1000);
    }

    return originalRect.call(this);
  };
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

beforeEach(() => {
  push.mockReset();
  window.localStorage.clear();
});

const taxSample = sampleCaseStates.find((state) => state.case.id === "sample-tax-notice")!;

function visitorCopy(state: CaseState, id: string): CaseState {
  const copy = structuredClone(state);
  return {
    ...copy,
    case: {
      ...copy.case,
      id,
      isSample: false,
      sourceCaseId: state.case.id,
      visitorId: testVisitorId,
    },
  };
}

async function openEvidenceAsync(description: string) {
  const chips = await screen.findAllByRole("button", { name: `Open evidence: ${description}` });
  fireEvent.click(chips[0]!);
}

function region(evidenceId: string): HTMLElement | null {
  return document.querySelector(`[data-evidence-region="${evidenceId}"]`);
}

function questionRow(questionId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `#open-questions [data-question-id="${questionId}"]`,
  );
  if (!row) {
    throw new Error(`No checklist row for ${questionId}`);
  }

  return row;
}

describe("review workspace", { timeout }, () => {
  it("opens the PDF viewer at the evidence bbox from a chip", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    await openEvidenceAsync("Adjustment table in the intimation");

    const page = await screen.findByTestId("pdf-page", {}, slow);
    expect(page).toHaveAttribute("data-page-number", "2");
    expect(screen.getByTestId("pdf-document")).toHaveAttribute(
      "data-file",
      "/fixtures/intimation_143_1a_AY2025-26.pdf",
    );
    const highlight = await waitFor(() => {
      const element = region("b-ev-notice-para");
      expect(element).not.toBeNull();
      return element!;
    }, slow);
    expect(highlight).toHaveAttribute("data-focused", "true");
    expect(highlight.style.left).toBe("8%");
    expect(highlight.style.top).toBe("42%");
    expect(highlight.style.width).toBe("84%");
    expect(highlight.style.height).toBe("12%");
    expect(screen.queryByTestId("approximate-highlight")).not.toBeInTheDocument();
  });

  it("labels OCR highlights as approximate and shows the reading confidence", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    await openEvidenceAsync("Part A of Form 26AS, deductors list");

    expect(await screen.findByTestId("pdf-page", {}, slow)).toHaveAttribute(
      "data-page-number",
      "3",
    );
    expect(await screen.findByTestId("approximate-highlight", {}, slow)).toBeInTheDocument();
    expect(screen.getByTestId("reading-confidence")).toHaveTextContent("OCR confidence 84%");
    expect(screen.getByRole("link", { name: /View original/ })).toHaveAttribute(
      "href",
      "/fixtures/form26AS_AY2025-26_scan.pdf",
    );
  });

  it("falls back to the quoted text in the PDF text layer when there is no bbox", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-msme-payment" />);

    await openEvidenceAsync("Udyam registration number and date of registration");

    const highlight = await waitFor(() => {
      const element = region("c-ev-udyam");
      expect(element).not.toBeNull();
      return element!;
    }, slow);
    expect(highlight).toHaveAttribute("data-focused", "true");
    expect(highlight.style.left).toBe("8%");
    expect(highlight.style.top).toBe("30%");
    expect(document.querySelector("[data-page-highlight]")).toBeNull();
  });

  it("lists the findings that cite a selected spreadsheet row or PDF region", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    await openEvidenceAsync("Receipts from Mehta Exports with TDS deducted");
    const sheet = await screen.findByRole("table", { name: /sheet Receipts/ });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Row 184, highlighted/ }));

    const lookup = await screen.findByTestId("reverse-lookup");
    expect(lookup).toHaveTextContent("1 finding cites Receipts row 184");
    expect(
      within(lookup).getByRole("button", { name: /12,400 gap is TDS by one deductor/ }),
    ).toBeInTheDocument();
    const sections = within(lookup).getByRole("list", { name: "Citing sections" });
    expect(
      within(sections).getByRole("button", { name: "TDS reconciliation" }),
    ).toBeInTheDocument();
    expect(within(sections).getByRole("button", { name: "Draft response" })).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Row 178\./ }));
    expect(await screen.findByTestId("reverse-lookup")).toHaveTextContent(
      "No findings cite Receipts row 178",
    );

    await openEvidenceAsync("Part A of Form 26AS, deductors list");
    const pdfRegion = await waitFor(() => {
      const element = region("b-ev-26as-page");
      expect(element).not.toBeNull();
      return element!;
    }, slow);
    fireEvent.click(pdfRegion);
    const pdfLookup = await screen.findByTestId("reverse-lookup");
    expect(pdfLookup).toHaveTextContent("form26AS_AY2025-26_scan.pdf, page 3");
    expect(
      within(pdfLookup).getByRole("button", { name: /12,400 gap is TDS by one deductor/ }),
    ).toBeInTheDocument();
  });

  it("links reconciliation rows only to the sources that name them", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    const section = await screen.findByRole("region", { name: "TDS reconciliation" });
    const mehta = within(section).getByRole("list", { name: "Sources for Mehta Exports" });
    expect(
      within(mehta)
        .getAllByRole("button")
        .map((chip) => chip.getAttribute("data-evidence-id")),
    ).toEqual(["b-ev-ledger-rows"]);
    expect(
      within(section).queryByRole("list", { name: "Sources for Other deductors" }),
    ).not.toBeInTheDocument();
    const sectionSources = within(section).getByRole("list", {
      name: "Evidence for TDS reconciliation",
    });
    expect(within(sectionSources).getAllByRole("button")).toHaveLength(2);
  });

  it("keeps approval consistent when usage refreshes while approval is pending", async () => {
    const copy = visitorCopy(taxSample, "case-approval-race");
    const dataSource = createTestDataSource({ seedStates: [copy] });
    const realApprove = dataSource.approveCaseAsync.bind(dataSource);
    const pending: { settle?: (approve: boolean) => void } = {};
    vi.spyOn(dataSource, "approveCaseAsync").mockImplementation(
      (caseId, note) =>
        new Promise((resolve, reject) => {
          pending.settle = (approve) =>
            approve
              ? resolve(realApprove(caseId, note))
              : reject(new ApiError("The server is busy.", 503));
        }),
    );
    const refreshSpy = vi.spyOn(dataSource, "getCaseStateAsync");
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    async function approveWhileAskSettlesAsync() {
      fireEvent.click(
        await screen.findByRole("button", { name: /^Review (and approve|approval)$/ }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Approve this case" });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Approve/ }));
      expect(await screen.findByTestId("approval-badge")).toBeInTheDocument();
      const loads = refreshSpy.mock.calls.length;
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Ask/ }));
      fireEvent.click(screen.getByRole("button", { name: "Why is the TDS mismatch 12,400?" }));
      await waitFor(() => expect(refreshSpy.mock.calls.length).toBeGreaterThan(loads), slow);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    await approveWhileAskSettlesAsync();
    await act(async () => {
      pending.settle?.(false);
    });
    await waitFor(() => expect(screen.queryByTestId("approval-badge")).not.toBeInTheDocument());

    await approveWhileAskSettlesAsync();
    await act(async () => {
      pending.settle?.(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId("approval-badge")).toHaveTextContent("16 Oct 2026"),
    );
    expect(screen.getByTestId("approval-badge")).toHaveTextContent("with 2 open items");
  });

  it("streams an Ask answer, cites evidence, and shows the findings used", async () => {
    const dataSource = createTestDataSource();
    let finish: () => void = () => {};

    const askSpy = vi
      .spyOn(dataSource, "askAsync")
      .mockImplementation(async (_caseId, _question, options): Promise<AskResult> => {
        options?.onDelta?.("The gap is TDS ");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        options?.onDelta?.("filed under the wrong PAN.");
        return {
          status: "answered",
          answer: "The gap is TDS filed under the wrong PAN.",
          evidenceIds: ["b-ev-ledger-rows"],
          findingIds: ["b-finding-mismatch"],
          evidence: [],
          retrievedFindingIds: ["b-finding-mismatch"],
        };
      });
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />, dataSource);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Ask/ }));
    const loadState = dataSource.getCaseStateAsync.bind(dataSource);
    const stateSpy = vi.spyOn(dataSource, "getCaseStateAsync").mockImplementation(async (id) => {
      const state = await loadState(id);
      return {
        ...state,
        case: { ...state.case, usage: { ...state.case.usage!, costEstimate: 0.0701 } },
      };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Why is the TDS mismatch 12,400?" }));

    const answer = await screen.findByTestId("answer-text", {}, slow);
    expect(answer).toHaveTextContent("The gap is TDS");
    expect(answer.closest("[data-answer-status]")).toHaveAttribute(
      "data-answer-status",
      "streaming",
    );
    expect(askSpy).toHaveBeenCalledWith(
      "sample-tax-notice",
      "Why is the TDS mismatch 12,400?",
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );

    await act(async () => {
      finish();
    });

    const log = screen.getByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getByTestId("answer-text")).toHaveTextContent(
        "The gap is TDS filed under the wrong PAN.",
      ),
    );
    const used = within(log).getByRole("list", { name: "Findings used" });
    expect(within(used).getByRole("button", { name: /12,400 gap is TDS/ })).toBeInTheDocument();
    expect(screen.getByTestId("ask-announcer")).toHaveTextContent("Answer ready");
    await waitFor(() => expect(screen.getByTestId("running-cost")).toHaveTextContent("$0.0701"));
    expect(stateSpy).toHaveBeenCalled();

    fireEvent.click(
      within(log).getByRole("button", {
        name: "Open evidence: Receipts from Mehta Exports with TDS deducted",
      }),
    );
    expect(await screen.findByRole("tab", { name: /Evidence/ })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(await screen.findByTestId("evidence-details")).toHaveTextContent(
      "Receipts rows 182-190",
    );
  });

  it("refreshes usage after a failed Ask request", async () => {
    const dataSource = createTestDataSource();
    vi.spyOn(dataSource, "askAsync").mockRejectedValue(
      new ApiError("The assistant could not answer right now.", 200, { code: "ask-failed" }),
    );
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />, dataSource);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Ask/ }));
    const refreshSpy = vi.spyOn(dataSource, "getCaseStateAsync");
    fireEvent.click(await screen.findByRole("button", { name: "Why is the TDS mismatch 12,400?" }));

    expect(
      await screen.findByText("The assistant could not answer right now."),
    ).toBeInTheDocument();
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledWith("sample-tax-notice"));
  });

  it("holds approval until pending review changes are saved", async () => {
    const copy = visitorCopy(taxSample, "case-approval-waits");
    const dataSource = createTestDataSource({ seedStates: [copy] });
    const realResolve = dataSource.resolveOpenQuestionAsync.bind(dataSource);
    let release: () => void = () => {};

    vi.spyOn(dataSource, "resolveOpenQuestionAsync").mockImplementation(
      async (caseId, questionId, note) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return realResolve(caseId, questionId, note);
      },
    );
    const approveSpy = vi.spyOn(dataSource, "approveCaseAsync");
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    const question =
      "Has Mehta Exports been asked to file a correction statement with the right PAN?";
    fireEvent.click(await screen.findByRole("button", { name: `Resolve: ${question}` }));
    fireEvent.click(screen.getByRole("button", { name: `Confirm resolve: ${question}` }));
    fireEvent.click(screen.getByRole("button", { name: /Review and approve/ }));

    const dialog = await screen.findByRole("dialog", { name: "Approve this case" });
    expect(within(dialog).getByTestId("approval-waiting")).toBeInTheDocument();
    const approve = within(dialog).getByRole("button", { name: "Approve with 1 open" });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(approveSpy).not.toHaveBeenCalled();

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(within(dialog).queryByTestId("approval-waiting")).not.toBeInTheDocument(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve with 1 open" }));
    await waitFor(() => expect(approveSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("approval-badge")).toHaveTextContent("with 1 open item");
  });

  it("offers to flag an unsupported question for review", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Ask/ }));
    const input = await screen.findByLabelText("Ask a question about this case");
    fireEvent.change(input, { target: { value: "What is the weather in Pune?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const flag = await screen.findByRole("button", { name: "Flag for review" }, slow);
    expect(screen.getByRole("log", { name: "Conversation" })).toHaveTextContent(
      "does not cover this question",
    );
    fireEvent.click(flag);

    const flagged = await screen.findByRole("list", { name: "Flagged questions" });
    expect(flagged).toHaveTextContent("Answer needed: What is the weather in Pune?");
    expect(screen.getByTestId("open-question-count")).toHaveTextContent("3 open");
    expect(
      JSON.parse(window.localStorage.getItem("evianta.review-notes.sample-tax-notice") ?? "[]"),
    ).toHaveLength(1);
  });

  it("edits the draft with a reviewer badge and a before and after view", async () => {
    const copy = visitorCopy(taxSample, "case-tax-copy");
    const dataSource = createTestDataSource({ seedStates: [copy] });
    const updateSpy = vi.spyOn(dataSource, "updateSectionAsync");
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    const draft = await screen.findByRole("region", { name: "Draft response" });
    fireEvent.click(within(draft).getByRole("button", { name: "Edit" }));
    const editor = within(draft).getByRole("textbox", { name: /Edit the text/ });
    fireEvent.change(editor, {
      target: { value: "We request that the credit of 12,400 be allowed under section 154." },
    });
    fireEvent.click(within(draft).getByRole("button", { name: "Save edit" }));

    expect(await within(draft).findByText("Edited by reviewer")).toBeInTheDocument();
    expect(updateSpy).toHaveBeenCalledWith(copy.case.id, "b-deliverable-pack", "b-section-draft", {
      editedContent: "We request that the credit of 12,400 be allowed under section 154.",
    });
    fireEvent.click(within(draft).getByRole("button", { name: "Before and after" }));
    expect(within(draft).getByTestId("before-content")).toHaveTextContent(
      "With reference to the intimation under section 143(1)(a)",
    );
    expect(within(draft).getByTestId("after-content")).toHaveTextContent(
      "We request that the credit of 12,400 be allowed under section 154.",
    );
  });

  it("keeps the edit open with the reviewer's text when saving fails", async () => {
    const copy = visitorCopy(taxSample, "case-edit-failure");
    const dataSource = createTestDataSource({ seedStates: [copy] });
    vi.spyOn(dataSource, "updateSectionAsync").mockRejectedValue(
      new ApiError("The server is busy.", 503),
    );
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    const draft = await screen.findByRole("region", { name: "Draft response" });
    fireEvent.click(within(draft).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(draft).getByRole("textbox", { name: /Edit the text/ }), {
      target: { value: "Unsaved reviewer text" },
    });
    fireEvent.click(within(draft).getByRole("button", { name: "Save edit" }));

    await waitFor(() =>
      expect(within(draft).getByRole("textbox", { name: /Edit the text/ })).toHaveValue(
        "Unsaved reviewer text",
      ),
    );
    expect(within(draft).queryByText("Edited by reviewer")).not.toBeInTheDocument();
  });

  it("keeps the Ask conversation when the side sheet closes on a narrow screen", async () => {
    stubMatchMedia(true, { viewportWidth: 800 });
    try {
      renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

      fireEvent.click(await screen.findByRole("button", { name: "Evidence and Ask" }));
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Ask/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Why is the TDS mismatch 12,400?" }),
      );
      await screen.findByRole("list", { name: "Findings used" }, slow);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Evidence and Ask" }));
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Ask/ }));
      expect(await screen.findByRole("log", { name: "Conversation" })).toHaveTextContent(
        "Why is the TDS mismatch 12,400?",
      );
    } finally {
      stubMatchMedia(true, { viewportWidth: 1440 });
    }
  });

  it("lists unresolved high-severity items first in the approval gate", async () => {
    const copy = visitorCopy(taxSample, "case-approval-copy");
    copy.findings = copy.findings.map((finding, index) =>
      index === 0
        ? {
            ...finding,
            openQuestions: [
              {
                id: "q-low-first",
                text: "Attach the challan copy",
                severity: "low",
                status: "open",
              },
            ],
          }
        : finding,
    );
    const dataSource = createTestDataSource({ seedStates: [copy] });
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    fireEvent.click(await screen.findByRole("button", { name: /Review and approve/ }));

    const dialog = await screen.findByRole("dialog", { name: "Approve this case" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "3 items are still open, 1 of high severity.",
    );
    const items = within(
      within(dialog).getByRole("list", { name: "Unresolved items" }),
    ).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-severity"))).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(items[0]).toHaveTextContent("Has Mehta Exports been asked to file a correction");
    expect(dialog).toHaveTextContent("Form 16A from Mehta Exports reflects the deduction");

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve with 3 open" }));

    expect(await screen.findByTestId("approval-badge")).toHaveTextContent("with 3 open items");
  });

  it("resolves an open question at once and rolls back a failed dismissal", async () => {
    const copy = visitorCopy(taxSample, "case-questions-copy");
    const dataSource = createTestDataSource({ seedStates: [copy] });
    const realResolve = dataSource.resolveOpenQuestionAsync.bind(dataSource);
    let releaseResolve: () => void = () => {};

    vi.spyOn(dataSource, "resolveOpenQuestionAsync").mockImplementation(
      async (caseId, questionId, note) => {
        await new Promise<void>((resolve) => {
          releaseResolve = resolve;
        });
        return realResolve(caseId, questionId, note);
      },
    );
    let rejectDismiss: (error: Error) => void = () => {};

    vi.spyOn(dataSource, "dismissOpenQuestionAsync").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDismiss = reject;
        }),
    );
    renderWithDataSource(<CaseWorkspace caseId={copy.case.id} />, dataSource);

    const panQuestion =
      "Has Mehta Exports been asked to file a correction statement with the right PAN?";
    fireEvent.click(await screen.findByRole("button", { name: `Resolve: ${panQuestion}` }));
    fireEvent.change(within(questionRow("b-q-pan-correction")).getByRole("textbox"), {
      target: { value: "Deductor filed the correction on 10 Oct" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Confirm resolve: ${panQuestion}` }));

    expect(questionRow("b-q-pan-correction")).toHaveAttribute("data-question-status", "resolved");
    expect(questionRow("b-q-pan-correction")).toHaveTextContent(
      "Note: Deductor filed the correction on 10 Oct",
    );
    await act(async () => {
      releaseResolve();
    });
    await waitFor(() =>
      expect(questionRow("b-q-pan-correction")).toHaveAttribute("data-question-status", "resolved"),
    );

    const lawQuestion = "Verify the cited provisions against the law in force for AY 2025-26.";
    fireEvent.click(screen.getByRole("button", { name: `Dismiss: ${lawQuestion}` }));
    fireEvent.click(screen.getByRole("button", { name: `Confirm dismiss: ${lawQuestion}` }));
    expect(questionRow("b-q-verify-law")).toHaveAttribute("data-question-status", "dismissed");

    await act(async () => {
      rejectDismiss(new ApiError("The server is busy.", 503));
    });
    await waitFor(() =>
      expect(questionRow("b-q-verify-law")).toHaveAttribute("data-question-status", "open"),
    );
  });
});
