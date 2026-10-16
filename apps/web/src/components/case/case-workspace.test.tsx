import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { failedCaseId, failedCaseState, failedRunEvents, fixtureFailure } from "@/fixtures";
import { failedRunMessage } from "@/fixtures/run-events";
import { casePlannedUploadMessage } from "@/hooks/use-case-workspace";
import {
  createTestDataSource,
  renderWithDataSource,
  stubResizeObserver,
} from "@/test/render-with-data";
import { CaseWorkspace } from "./case-workspace";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/cases/test",
}));

const streamTimeoutMs = 15000;

beforeAll(() => {
  stubResizeObserver();
});

beforeEach(() => {
  push.mockReset();
});

describe("CaseWorkspace", () => {
  it("renders a sample case from fixtures with findings, deliverables, and cost", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    expect(
      await screen.findByRole("heading", { level: 1, name: /ITR intimation 143\(1\)\(a\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Fixture mode");
    expect(screen.getByRole("region", { name: "Read-only sample" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run case/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /12,400 gap is TDS/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Draft response" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export Response pack/ })).toBeInTheDocument();
    expect(screen.getByTestId("case-cost")).toHaveTextContent("$0.0688");
    expect(screen.getByText("Handwriting detected, flagged for review")).toBeInTheDocument();
    expect(screen.getByTestId("run-announcer")).toHaveAttribute("aria-live", "polite");
  });

  it("opens the evidence drawer from an evidence chip", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-tax-notice" />);

    const evidence = await screen.findAllByRole("button", {
      name: "Open evidence: Receipts from Mehta Exports with TDS deducted",
    });
    fireEvent.click(evidence[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Receipts rows 182-190")).toBeInTheDocument();
    expect(within(dialog).getByText(/12,400 gap is TDS/)).toBeInTheDocument();
  });

  it("renders the use case A dashboard charts", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-data-analysis" />);

    expect(await screen.findByRole("figure", { name: /Net sales by month/ })).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: /Return rate by region/ })).toBeInTheDocument();
    expect(
      screen.getByRole("figure", { name: /Cumulative net sales, quarter to date/ }),
    ).toHaveAttribute("data-chart-type", "area");
    expect(
      screen.getByRole("figure", { name: /Share of net sales by region/ }),
    ).toBeInTheDocument();
  });

  it("copies a sample with Try this case", async () => {
    renderWithDataSource(<CaseWorkspace caseId="sample-msme-payment" />);

    fireEvent.click(await screen.findByRole("button", { name: "Try this case" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/cases\/case-/)),
    );
  });

  it(
    "shows the failed step, blocked steps, and retries only what failed",
    async () => {
      const dataSource = createTestDataSource({
        seedStates: [failedCaseState],
        seedEvents: { [failedCaseId]: failedRunEvents },
      });
      const retrySpy = vi.spyOn(dataSource, "retryRunAsync");
      renderWithDataSource(<CaseWorkspace caseId={failedCaseId} />, dataSource);

      expect(await screen.findByTestId("task-last-error")).toHaveTextContent(fixtureFailure.error);
      const blocked = screen.getByRole("list", { name: "Blocked steps" });
      expect(within(blocked).getAllByRole("listitem")).toHaveLength(2);
      expect(screen.getByTestId("run-error")).toHaveTextContent(failedRunMessage);
      expect(screen.getByTestId("upload-locked")).toHaveTextContent(casePlannedUploadMessage);

      fireEvent.click(screen.getByRole("button", { name: /Retry failed steps/ }));

      await waitFor(() => expect(retrySpy).toHaveBeenCalledWith(failedCaseId));
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "A step failed" })).not.toBeInTheDocument(),
      );
      await waitFor(
        () => expect(screen.getByRole("region", { name: "Claim summary" })).toBeInTheDocument(),
        { timeout: streamTimeoutMs },
      );
      const steps = screen.getByRole("list", { name: "Steps" });
      expect(
        within(steps)
          .getAllByRole("listitem")
          .every((item) => item.getAttribute("data-task-status") === "completed"),
      ).toBe(true);
    },
    streamTimeoutMs * 2,
  );

  it(
    "runs a new case without documents and streams progress to completion",
    async () => {
      const dataSource = createTestDataSource();
      const created = await dataSource.createCaseAsync({
        title: "Sales check",
        useCase: "data-analysis",
      });
      renderWithDataSource(<CaseWorkspace caseId={created.id} />, dataSource);

      fireEvent.click(await screen.findByRole("button", { name: /Run case/ }));
      expect(screen.getByRole("region", { name: "Progress" })).not.toHaveAttribute("aria-busy");

      await waitFor(
        () => expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
        { timeout: streamTimeoutMs },
      );
      expect(screen.getByText("4 of 4 steps done")).toBeInTheDocument();
      expect(screen.getByTestId("running-cost")).toHaveTextContent("$0.0213");
    },
    streamTimeoutMs * 2,
  );

  it(
    "holds the run until uploads finish, then closes uploads once planned",
    async () => {
      const dataSource = createTestDataSource({ replayIntervalMs: 50 });
      const created = await dataSource.createCaseAsync({
        title: "Sales check",
        useCase: "data-analysis",
      });
      const startSpy = vi.spyOn(dataSource, "startRunAsync");
      const { container } = renderWithDataSource(<CaseWorkspace caseId={created.id} />, dataSource);
      const runButton = await screen.findByRole("button", { name: /Run case/ });
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

      fireEvent.change(input, { target: { files: [new File(["a,b"], "sales.csv")] } });

      expect(runButton).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for uploads to finish");
      await waitFor(() => expect(runButton).toBeEnabled());
      fireEvent.click(runButton);

      await waitFor(
        () => expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument(),
        { timeout: streamTimeoutMs },
      );
      expect(startSpy).toHaveBeenCalledTimes(1);
      await expect(startSpy.mock.results[0]!.value).resolves.toMatchObject({ mode: "run" });
      expect(screen.queryByText(/did not start/)).not.toBeInTheDocument();
      expect(screen.getByText("sales.csv")).toBeInTheDocument();
      expect(screen.getByTestId("upload-locked")).toHaveTextContent(casePlannedUploadMessage);
    },
    streamTimeoutMs * 2,
  );
  it(
    "waits for the API to release a finished run instead of subscribing again",
    async () => {
      const dataSource = createTestDataSource();
      const created = await dataSource.createCaseAsync({
        title: "Sales check",
        useCase: "data-analysis",
      });
      const getStateAsync = dataSource.getCaseStateAsync.bind(dataSource);
      let staleSnapshots = 0;
      vi.spyOn(dataSource, "getCaseStateAsync").mockImplementation(async (id) => {
        const state = await getStateAsync(id);
        if (staleSnapshots === 0 && state.run.lastEventType === "run-completed") {
          staleSnapshots += 1;
          return { ...state, run: { ...state.run, active: true } };
        }

        return state;
      });
      const subscribeSpy = vi.spyOn(dataSource, "subscribeToRun");
      renderWithDataSource(<CaseWorkspace caseId={created.id} />, dataSource);

      fireEvent.click(await screen.findByRole("button", { name: /Run case/ }));

      await waitFor(() => expect(screen.getByRole("button", { name: /Run again/ })).toBeEnabled(), {
        timeout: streamTimeoutMs,
      });
      expect(staleSnapshots).toBe(1);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
    },
    streamTimeoutMs * 2,
  );
});
