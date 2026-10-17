import { render, screen } from "@testing-library/react";
import type { CaseDocument } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import { documentErrorMessages } from "@/lib/labels";
import { DocumentPanel } from "./document-panel";

const baseDocument: CaseDocument = {
  id: "doc-1",
  caseId: "case-1",
  name: "notice.pdf",
  mimeType: "application/pdf",
  size: 2048,
  uploadedAt: "2026-10-01T10:00:00.000Z",
  status: "failed",
};

function renderPanel(documents: CaseDocument[], uploadLockedReason?: string) {
  return render(
    <DocumentPanel
      documents={documents}
      uploads={[]}
      readOnly={false}
      uploadLockedReason={uploadLockedReason}
      onUpload={vi.fn()}
      onDismissUpload={vi.fn()}
    />,
  );
}

describe("DocumentPanel", () => {
  it("explains a known document error code in plain language", () => {
    renderPanel([
      { ...baseDocument, errorCode: "ocr-unavailable", error: "Text recognition is off." },
    ]);

    expect(screen.getByTestId("document-error")).toHaveTextContent(
      documentErrorMessages["ocr-unavailable"],
    );
  });

  it("falls back to the server message for an unknown code", () => {
    renderPanel([{ ...baseDocument, errorCode: "new-code", error: "Could not be read." }]);

    expect(screen.getByTestId("document-error")).toHaveTextContent("Could not be read.");
  });

  it("replaces the upload area with the reason uploads are closed", () => {
    renderPanel([], "Documents cannot be added once the case has been planned.");

    expect(screen.getByTestId("upload-locked")).toHaveTextContent("has been planned");
    expect(screen.queryByRole("button", { name: "Upload documents" })).not.toBeInTheDocument();
  });

  it("offers uploads while the case is open", () => {
    renderPanel([]);

    expect(screen.getByRole("button", { name: "Upload documents" })).toBeInTheDocument();
    expect(screen.queryByTestId("upload-locked")).not.toBeInTheDocument();
  });
});
