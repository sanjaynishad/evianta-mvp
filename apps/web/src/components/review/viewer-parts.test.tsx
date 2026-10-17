import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Evidence, ExtractedTable } from "@evianta/core";
import { evidenceNamingLabel, type EvidenceEntry } from "@/lib/evidence";
import { scrollIntoPane } from "@/lib/scroll";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SectionBody } from "./section-body";
import { formatCell, SpreadsheetViewer } from "./spreadsheet-viewer";
import { TextSourceViewer } from "./text-source-viewer";

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/hooks/use-motion-safe", () => ({
  useMotionSafe: () => motion,
}));

vi.mock("@/lib/scroll", () => ({ scrollIntoPane: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  motion.reduced = false;
});

function entry(id: string, evidence: Partial<Evidence>): EvidenceEntry {
  return {
    evidence: { id, sourceRef: "source", description: "", ...evidence },
    findingIds: [],
  };
}

describe("formatCell", () => {
  it("keeps the precision of numeric source cells", () => {
    expect(formatCell(0.000123)).toBe("0.000123");
    expect(formatCell(0.092)).toBe("0.092");
    expect(formatCell(1234567.5)).toBe("12,34,567.5");
    expect(formatCell(null)).toBe("");
  });
});

describe("SectionBody text formatting", () => {
  it("renders bold and italic labels without exposing Markdown markers", () => {
    render(
      <SectionBody
        section={{
          id: "draft",
          title: "Draft",
          kind: "text",
          content: "",
          producedByRole: "case-preparation",
          findingIds: [],
          evidenceIds: [],
          reviewStatus: "pending",
        }}
        content="**Subject:** Follow up\n\n_Prepared for review._"
        sources={[]}
        onOpenEvidence={vi.fn()}
      />,
    );

    expect(screen.getByText("Subject:", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Prepared for review.", { selector: "em" })).toBeInTheDocument();
    expect(screen.queryByText(/\*\*|_/)).not.toBeInTheDocument();
  });
});

describe("SpreadsheetViewer citation scrolling", () => {
  const table: ExtractedTable = {
    name: "Sales",
    sheet: "Sales",
    range: "A1:H3",
    columns: Array.from({ length: 8 }, (_, index) => ({ name: `Column ${index + 1}` })),
    rows: [
      ["A2", "B2", "C2", "D2", "E2", "F2", "G2", "H2"],
      ["A3", "B3", "C3", "D3", "E3", "F3", "G3", "H3"],
    ],
  };

  it.each(["A2", "H2:H3"])("scrolls to the first cited cell for %s", (cellRange) => {
    render(
      <SpreadsheetViewer
        documentName="sales.xlsx"
        tables={[table]}
        entries={[entry("citation", { location: { sheet: "Sales", cellRange } })]}
        focusEvidenceId="citation"
        requestId={1}
        onSelectRow={vi.fn()}
      />,
    );

    expect(scrollIntoPane).toHaveBeenCalledWith(
      document.querySelector(`[data-cell="${cellRange.split(":")[0]}"]`),
      { block: "center", behavior: "smooth" },
    );
  });

  it("falls back to the focused row when the cited column is not in the extraction", () => {
    motion.reduced = true;
    render(
      <SpreadsheetViewer
        documentName="sales.xlsx"
        tables={[table]}
        entries={[entry("citation", { location: { sheet: "Sales", cellRange: "Z2" } })]}
        focusEvidenceId="citation"
        requestId={1}
        onSelectRow={vi.fn()}
      />,
    );

    expect(scrollIntoPane).toHaveBeenCalledWith(document.querySelector("[data-focus-row]"), {
      block: "center",
      behavior: "auto",
    });
  });
});

describe("evidenceNamingLabel", () => {
  const ledger = entry("ledger", { description: "Receipts from Mehta Exports with TDS deducted" });
  const statement = entry("26as", {
    description: "Part A of Form 26AS, deductors list",
    location: { textQuote: "Total TDS 1,86,600" },
  });

  it("links a row only to evidence that names it", () => {
    expect(evidenceNamingLabel([ledger, statement], "Mehta Exports")).toEqual([ledger]);
    expect(evidenceNamingLabel([ledger, statement], "Other deductors")).toEqual([]);
    expect(evidenceNamingLabel([ledger, statement], "Mehta")).toEqual([ledger]);
    expect(evidenceNamingLabel([ledger, statement], "Total")).toEqual([]);
    expect(evidenceNamingLabel([ledger, statement], "Export")).toEqual([]);
  });
});

describe("TextSourceViewer", () => {
  it("highlights a quote whose whitespace differs from the extracted text", () => {
    render(
      <TextSourceViewer
        documentName="notice.pdf"
        extraction={{
          documentId: "doc",
          kind: "text",
          method: "pdf-text",
          confidence: 1,
          pages: [
            {
              index: 1,
              text: "Particulars\nDifference\n12,400",
              method: "pdf-text",
              confidence: 1,
            },
          ],
          tables: [],
          warnings: [],
        }}
        page={1}
        quote="Difference 12,400"
        requestId={1}
      />,
    );

    const mark = document.querySelector("[data-quote-highlight]");
    expect(mark?.textContent).toBe("Difference\n12,400");
    expect(screen.getByText(/Particulars/)).toBeInTheDocument();
    expect(scrollIntoPane).toHaveBeenCalledWith(mark, { block: "center", behavior: "smooth" });
  });

  it("reveals a late-loaded quote, new citations on the same page, and page changes", () => {
    motion.reduced = true;
    const props = {
      documentName: "notice.pdf",
      page: 1,
      quote: "First quote",
      requestId: 1,
    };
    const { rerender } = render(<TextSourceViewer {...props} />);
    expect(scrollIntoPane).not.toHaveBeenCalled();

    const extraction = {
      documentId: "doc",
      kind: "text" as const,
      method: "pdf-text" as const,
      confidence: 1,
      pages: [1, 2].map((index) => ({
        index,
        text: `${"Context\n".repeat(200)}First quote. Second quote.`,
        method: "pdf-text" as const,
        confidence: 1,
      })),
      tables: [],
      warnings: [],
    };
    rerender(<TextSourceViewer {...props} extraction={extraction} />);
    expect(scrollIntoPane).toHaveBeenLastCalledWith(
      document.querySelector("[data-quote-highlight]"),
      { block: "center", behavior: "auto" },
    );
    expect(scrollIntoPane).toHaveBeenCalledTimes(1);

    rerender(
      <TextSourceViewer {...props} extraction={extraction} quote="Second quote" requestId={2} />,
    );
    expect(document.querySelector("[data-quote-highlight]")).toHaveTextContent("Second quote");
    expect(scrollIntoPane).toHaveBeenCalledTimes(2);

    rerender(
      <TextSourceViewer {...props} extraction={extraction} quote="Second quote" requestId={3} />,
    );
    expect(scrollIntoPane).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(scrollIntoPane).toHaveBeenCalledTimes(4);

    rerender(
      <TextSourceViewer {...props} extraction={extraction} quote="Missing quote" requestId={4} />,
    );
    expect(document.querySelector("[data-quote-highlight]")).not.toBeInTheDocument();
    expect(scrollIntoPane).toHaveBeenCalledTimes(4);
  });

  it("describes parsed text as the original file's text", () => {
    const page = { index: 1, text: "Reminder sent", confidence: 1 };
    const extraction = (method: "parse" | "pdf-text") => ({
      documentId: "doc",
      kind: "text" as const,
      method,
      confidence: 1,
      pages: [{ ...page, method }],
      tables: [],
      warnings: [],
    });
    const { rerender } = render(
      <TextSourceViewer
        documentName="notes.txt"
        extraction={extraction("parse")}
        page={1}
        requestId={1}
      />,
    );

    expect(screen.getByText("Text read from the original file.")).toBeInTheDocument();

    rerender(
      <TextSourceViewer
        documentName="notice.pdf"
        extraction={extraction("pdf-text")}
        page={1}
        requestId={1}
      />,
    );
    expect(
      screen.getByText("Extracted text, shown because the original cannot be displayed here."),
    ).toBeInTheDocument();
  });
});

describe("Sheet", () => {
  it("keeps open sheets and their overlay out of print", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Evidence and Ask</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog")).toHaveClass("print:hidden");
    expect(document.querySelector("[data-slot='sheet-overlay']")).toHaveClass("print:hidden");
  });
});
