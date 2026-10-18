import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDataSource, renderWithDataSource } from "@/test/render-with-data";
import { IntakeView } from "./intake-view";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/cases/new",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
});

function checklistLabels() {
  const list = screen.getByRole("list", { name: "Document checklist" });
  return within(list)
    .getAllByRole("listitem")
    .filter((item) => item.hasAttribute("data-checklist-item"))
    .map((item) => item.getAttribute("data-checklist-item"));
}

function addFiles(input: HTMLInputElement, files: File[]) {
  fireEvent.change(input, { target: { files } });
}

describe("IntakeView", () => {
  it("shows each use case's own checklist and prefills the details", () => {
    renderWithDataSource(<IntakeView />);

    fireEvent.click(screen.getByRole("radio", { name: /Income-tax notice response/ }));
    expect(checklistLabels()).toEqual(["notice", "form-26as", "ledger", "computation"]);
    expect(screen.getByLabelText("Title")).toHaveValue("Notice under section 143(1)(a)");
    expect(screen.getAllByText("Recommended")).toHaveLength(3);
    expect(screen.getAllByText("Optional")).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: /MSME delayed-payment dispute/ }));
    expect(checklistLabels()).toEqual([
      "invoices",
      "purchase-orders",
      "statement",
      "udyam",
      "correspondence",
    ]);
    expect(screen.getByLabelText("Title")).toHaveValue("Delayed payment claim against a buyer");

    fireEvent.click(screen.getByRole("radio", { name: /Business data analysis/ }));
    expect(checklistLabels()).toEqual(["sales-data", "master-data", "targets"]);
  });

  it("ticks checklist items as matching files are added", () => {
    const { container } = renderWithDataSource(<IntakeView />);
    fireEvent.click(screen.getByRole("radio", { name: /Income-tax notice response/ }));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const generalInput = inputs[inputs.length - 1]!;

    addFiles(generalInput, [
      new File(["%PDF"], "Form26AS_AY2025-26.pdf", { type: "application/pdf" }),
      new File(["x"], "random-scan.png", { type: "image/png" }),
    ]);

    const form26as = container.querySelector('[data-checklist-item="form-26as"]');
    expect(form26as).toHaveAttribute("data-done", "true");
    expect(within(form26as as HTMLElement).getByText("Form26AS_AY2025-26.pdf")).toBeInTheDocument();
    expect(screen.getByText("Other documents")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 checklist items added")).toBeInTheDocument();
  });

  it("does not let a user edit be overwritten when switching use case", () => {
    renderWithDataSource(<IntakeView />);
    fireEvent.click(screen.getByRole("radio", { name: /Income-tax notice response/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My notice" } });

    fireEvent.click(screen.getByRole("radio", { name: /Business data analysis/ }));

    expect(screen.getByLabelText("Title")).toHaveValue("My notice");
  });

  it("creates and runs a case with checklist items missing", async () => {
    const dataSource = createTestDataSource();
    const startRun = vi.spyOn(dataSource, "startRunAsync");
    renderWithDataSource(<IntakeView />, dataSource);

    fireEvent.click(screen.getByRole("radio", { name: /MSME delayed-payment dispute/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create and run/ }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/cases\/case-/)),
    );
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(await dataSource.listCasesAsync()).toHaveLength(1);
  });

  it("freezes the form while the case is being created", async () => {
    const dataSource = createTestDataSource();
    let releaseCreate: () => void = () => {};

    const createCaseAsync = dataSource.createCaseAsync.bind(dataSource);
    vi.spyOn(dataSource, "createCaseAsync").mockImplementation(
      (request) =>
        new Promise((resolve) => {
          releaseCreate = () => resolve(createCaseAsync(request));
        }),
    );
    const upload = vi.spyOn(dataSource, "uploadDocumentAsync");
    const { container } = renderWithDataSource(<IntakeView />, dataSource);

    fireEvent.click(screen.getByRole("radio", { name: /Business data analysis/ }));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const generalInput = inputs[inputs.length - 1]!;
    addFiles(generalInput, [new File(["a,b"], "sales.csv", { type: "text/csv" })]);
    fireEvent.click(screen.getByRole("button", { name: /Create case/ }));

    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Short description")).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Income-tax notice response/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove sales.csv" })).toBeDisabled();
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }

    for (const button of screen.getAllByRole("button", { name: /Add file for/ })) {
      expect(button).toBeDisabled();
    }

    fireEvent.click(screen.getByRole("button", { name: "Remove sales.csv" }));
    expect(screen.getByText("sales.csv")).toBeInTheDocument();
    addFiles(generalInput, [new File(["c,d"], "late.csv", { type: "text/csv" })]);
    fireEvent.drop(screen.getByText(/Drop any files here/).parentElement!, {
      dataTransfer: { files: [new File(["e,f"], "dropped.csv", { type: "text/csv" })] },
    });
    expect(screen.queryByText("late.csv")).not.toBeInTheDocument();
    expect(screen.queryByText("dropped.csv")).not.toBeInTheDocument();

    releaseCreate();

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/cases\/case-/)),
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[1].name).toBe("sales.csv");
  });

  it("does not start the run when a file fails to upload", async () => {
    const dataSource = createTestDataSource();
    const startRun = vi.spyOn(dataSource, "startRunAsync");
    vi.spyOn(dataSource, "uploadDocumentAsync").mockRejectedValue(new Error("Upload failed"));
    const { container } = renderWithDataSource(<IntakeView />, dataSource);

    fireEvent.click(screen.getByRole("radio", { name: /Business data analysis/ }));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    addFiles(inputs[inputs.length - 1]!, [new File(["a,b"], "sales.csv", { type: "text/csv" })]);
    fireEvent.click(screen.getByRole("button", { name: /Create and run/ }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/cases\/case-/)),
    );
    expect(startRun).not.toHaveBeenCalled();
  });
});
