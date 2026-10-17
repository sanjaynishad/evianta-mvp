import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Evidence } from "@evianta/core";
import { evidenceNamingLabel, type EvidenceEntry } from "@/lib/evidence";
import { formatCell } from "./spreadsheet-viewer";
import { TextSourceViewer } from "./text-source-viewer";

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
  });
});
