import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfidenceBadge } from "./confidence-badge";
import { DataTable } from "./data-table";
import { EmptyState } from "./empty-state";
import { EvidenceChip } from "./evidence-chip";
import { MoneyText, NumberText } from "./number-text";
import { ProvenanceBadge } from "./provenance-badge";
import { StatusBadge } from "./status-badge";
import { Timeline } from "./timeline";

describe("StatusBadge", () => {
  it("pairs the status label with a decorative icon", () => {
    render(<StatusBadge status="needs-input" />);
    const badge = screen.getByText("Needs input");
    expect(badge).toHaveAttribute("data-status", "needs-input");
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("accepts a label override", () => {
    render(<StatusBadge status="completed" label="Verified" />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });
});

describe("ConfidenceBadge", () => {
  it("renders a full text label", () => {
    render(<ConfidenceBadge level="unassessed" />);
    expect(screen.getByText("Not assessed")).toHaveAttribute("data-confidence", "unassessed");
  });

  it("keeps an accessible name when compact", () => {
    render(<ConfidenceBadge level="high" compact />);
    const badge = screen.getByTitle("Evidence confidence: High");
    expect(badge).toHaveTextContent("Evidence confidence: High");
  });
});

describe("ProvenanceBadge", () => {
  it("shows the provenance label and contributor", () => {
    render(<ProvenanceBadge kind="specialist" by="Reconciliation" />);
    expect(screen.getByText("Specialist")).toBeInTheDocument();
    expect(screen.getByText(/Reconciliation/)).toBeInTheDocument();
  });
});

describe("EvidenceChip", () => {
  it("is a toggle button that reports its selected state", () => {
    const onClick = vi.fn();
    render(<EvidenceChip label="form26AS.pdf" locator="p. 4" selected onClick={onClick} />);
    const chip = screen.getByRole("button", { name: /form26AS\.pdf p\. 4/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAttribute("type", "button");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("MoneyText and NumberText", () => {
  it("renders rupees in mono tabular figures with the raw value", () => {
    render(<MoneyText amount={4_820_000} />);
    const amount = screen.getByText("₹48,20,000");
    expect(amount.tagName).toBe("DATA");
    expect(amount).toHaveAttribute("value", "4820000");
    expect(amount).toHaveClass("figures");
  });

  it("shows compact lakh and crore with the full value as a title", () => {
    render(
      <>
        <MoneyText amount={48_200_000} compact />
        <NumberText value={1_843_000} compact />
      </>,
    );
    expect(screen.getByText("₹4.82 crore")).toHaveAttribute("title", "₹4,82,00,000");
    expect(screen.getByText("18.43 lakh")).toHaveAttribute("title", "18,43,000");
  });
});

describe("DataTable", () => {
  it("right-aligns numeric columns in mono", () => {
    render(
      <DataTable
        columns={[
          { id: "item", header: "Item", cell: (row: { item: string; amount: number }) => row.item },
          {
            id: "amount",
            header: "Amount",
            numeric: true,
            cell: (row) => <MoneyText amount={row.amount} />,
          },
        ]}
        rows={[{ item: "Interest", amount: 42_000 }]}
        getRowId={(row) => row.item}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Amount" })).toHaveClass("text-right");
    const cell = screen.getByRole("cell", { name: "₹42,000" });
    expect(cell).toHaveClass("text-right", "font-mono", "tabular-nums");
  });

  it("renders an empty row when there is no data", () => {
    render(
      <DataTable
        columns={[{ id: "item", header: "Item", cell: (row: { id: string }) => row.id }]}
        rows={[]}
        getRowId={(row) => row.id}
        empty="Nothing reconciled yet."
      />,
    );
    expect(screen.getByText("Nothing reconciled yet.")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders the title, description, and primary action", () => {
    render(
      <EmptyState
        title="No cases yet"
        description="Start a case to begin."
        action={<button type="button">New case</button>}
      />,
    );
    expect(screen.getByText("No cases yet")).toBeInTheDocument();
    expect(screen.getByText("Start a case to begin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New case" })).toBeInTheDocument();
  });
});

describe("Timeline", () => {
  it("renders an ordered chronology with machine-readable dates", () => {
    render(
      <Timeline
        aria-label="Payment chronology"
        items={[
          { id: "invoice", date: "2026-01-12T10:00:00+05:30", title: "Invoice raised" },
          { id: "due", date: "2026-03-04T10:00:00+05:30", title: "Payment due", tone: "warning" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Payment chronology" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("12 Jan 2026")).toHaveAttribute(
      "dateTime",
      "2026-01-12T04:30:00.000Z",
    );
  });
});
