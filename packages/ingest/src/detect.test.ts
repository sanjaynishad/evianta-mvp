import { describe, expect, it } from "vitest";

import { createPng } from "./__fixtures__/fixtures.js";
import { detectDocumentFormat } from "./detect.js";
import { UnsupportedDocumentTypeError } from "./errors.js";

const csv = Buffer.from("a,b\n1,2\n");

describe("detectDocumentFormat", () => {
  it("trusts magic bytes over the declared type", () => {
    expect(
      detectDocumentFormat(createPng(), { name: "scan.bin", mimeType: "application/octet-stream" }),
    ).toEqual({ format: "image", mimeType: "image/png" });
    expect(
      detectDocumentFormat(Buffer.from("%PDF-1.7\n"), { name: "x", mimeType: "image/png" }),
    ).toEqual({ format: "pdf", mimeType: "application/pdf" });
    expect(
      detectDocumentFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        name: "a.jpg",
        mimeType: "image/jpg",
      }).mimeType,
    ).toBe("image/jpeg");
    expect(
      detectDocumentFormat(Buffer.from("II*\u0000rest", "latin1"), {
        name: "fax.tif",
        mimeType: "",
      }).mimeType,
    ).toBe("image/tiff");
  });

  it("detects delimited text from the MIME type or extension", () => {
    expect(
      detectDocumentFormat(csv, { name: "a.csv", mimeType: "application/vnd.ms-excel" }),
    ).toEqual({
      format: "csv",
      mimeType: "text/csv",
    });
    expect(
      detectDocumentFormat(csv, { name: "a", mimeType: "text/csv; charset=utf-8" }).format,
    ).toBe("csv");
    expect(detectDocumentFormat(csv, { name: "a.tsv", mimeType: "text/plain" }).format).toBe("tsv");
  });

  it("detects zip-based workbooks and legacy xls", () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("xl/workbook.xml"),
    ]);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

    expect(detectDocumentFormat(zip, { name: "book", mimeType: "application/zip" }).format).toBe(
      "xlsx",
    );
    expect(detectDocumentFormat(ole, { name: "old.xls", mimeType: "" }).format).toBe("xls");
  });

  it("rejects unsupported content with a typed error", () => {
    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("word/document.xml"),
    ]);

    for (const [buffer, metadata] of [
      [
        docx,
        {
          name: "letter.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
      [Buffer.from("hello"), { name: "notes.txt", mimeType: "text/plain" }],
      [Buffer.from("not an image"), { name: "photo.png", mimeType: "image/png" }],
      [Buffer.from([0, 1, 2, 3]), { name: "data.csv", mimeType: "text/csv" }],
    ] as const) {
      expect(() => detectDocumentFormat(buffer, metadata)).toThrow(UnsupportedDocumentTypeError);
    }
  });
});
