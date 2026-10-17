import { describe, expect, it } from "vitest";
import {
  isSupportedUploadFile,
  matchChecklistItem,
  partitionUploadFiles,
  supportedUploadMimeTypes,
  uploadAccept,
  useCaseDefinitions,
} from "./use-cases";

function file(name: string, type = ""): File {
  return new File(["data"], name, { type });
}

describe("upload allow list", () => {
  it.each([
    "sales.csv",
    "sales.tsv",
    "ledger.xlsx",
    "ledger.xls",
    "notice.pdf",
    "scan.png",
    "scan.jpg",
    "scan.jpeg",
    "scan.webp",
  ])("accepts %s", (name) => {
    expect(isSupportedUploadFile(file(name))).toBe(true);
  });

  it.each(["notes.docx", "archive.zip", "photo.heic", "README"])("rejects %s", (name) => {
    expect(isSupportedUploadFile(file(name))).toBe(false);
  });

  it("accepts a supported MIME type even without a known extension", () => {
    expect(isSupportedUploadFile(file("statement", "application/pdf"))).toBe(true);
  });

  it("lists every supported MIME type in the picker accept attribute", () => {
    for (const mimeType of supportedUploadMimeTypes) {
      expect(uploadAccept.split(",")).toContain(mimeType);
    }

    expect(uploadAccept.split(",")).toEqual(expect.arrayContaining([".csv", ".tsv", ".xls"]));
  });

  it("splits a drop into supported and unsupported files", () => {
    const { supported, unsupported } = partitionUploadFiles([
      file("sales.csv"),
      file("notes.docx"),
    ]);

    expect(supported.map((entry) => entry.name)).toEqual(["sales.csv"]);
    expect(unsupported.map((entry) => entry.name)).toEqual(["notes.docx"]);
  });
});

describe("matchChecklistItem", () => {
  it("matches by keyword before extension", () => {
    const checklist = useCaseDefinitions["tax-notice"].checklist;

    expect(matchChecklistItem("Form26AS_FY2024-25.pdf", checklist)?.id).toBe("form-26as");
    expect(matchChecklistItem("ledger_receipts.xlsx", checklist)?.id).toBe("ledger");
  });
});
