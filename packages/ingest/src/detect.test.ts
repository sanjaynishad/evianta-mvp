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
    expect(detectDocumentFormat(csv, { name: "data.tsv", mimeType: "text/csv" }).format).toBe(
      "csv",
    );
    expect(
      detectDocumentFormat(csv, { name: "data.csv", mimeType: "text/tab-separated-values" }).format,
    ).toBe("tsv");
  });

  it("detects JSON and JSON Lines from the MIME type or extension", () => {
    const content = Buffer.from('[{"a":1}]');
    const json = { format: "json", mimeType: "application/json" };
    const jsonl = { format: "jsonl", mimeType: "application/x-ndjson" };

    expect(detectDocumentFormat(content, { name: "a.json", mimeType: "" })).toEqual(json);
    expect(
      detectDocumentFormat(content, { name: "a", mimeType: "application/json; charset=utf-8" }),
    ).toEqual(json);
    expect(detectDocumentFormat(content, { name: "a", mimeType: "text/json" })).toEqual(json);
    expect(detectDocumentFormat(content, { name: "a", mimeType: "application/ld+json" })).toEqual(
      json,
    );
    expect(
      detectDocumentFormat(content, { name: "a.json", mimeType: "application/octet-stream" }),
    ).toEqual(json);
    expect(detectDocumentFormat(content, { name: "a.jsonl", mimeType: "" })).toEqual(jsonl);
    expect(
      detectDocumentFormat(content, { name: "a.ndjson", mimeType: "application/json" }),
    ).toEqual(jsonl);
    expect(detectDocumentFormat(content, { name: "a", mimeType: "application/x-ndjson" })).toEqual(
      jsonl,
    );
    expect(() =>
      detectDocumentFormat(Buffer.from([0x7b, 0, 0x7d]), {
        name: "a.json",
        mimeType: "application/json",
      }),
    ).toThrow(UnsupportedDocumentTypeError);
  });

  it("does not treat an embedded %PDF- string as a PDF header", () => {
    const signed = Buffer.from("Label,Value\nSignature,%PDF-1.7\n");
    const png = Buffer.concat([createPng(), Buffer.from("tEXt%PDF-1.7")]);

    expect(detectDocumentFormat(signed, { name: "signed.csv", mimeType: "text/csv" })).toEqual({
      format: "csv",
      mimeType: "text/csv",
    });
    expect(detectDocumentFormat(png, { name: "scan.png", mimeType: "image/png" }).mimeType).toBe(
      "image/png",
    );
  });

  it("accepts a PDF header after leading junk when the file ends with a PDF trailer", () => {
    const pdf = Buffer.from("junk bytes\n%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n");
    const noTrailer = Buffer.from("notes\n%PDF-1.7 mentioned here\n");

    expect(detectDocumentFormat(pdf, { name: "a.pdf", mimeType: "application/pdf" }).format).toBe(
      "pdf",
    );
    expect(detectDocumentFormat(noTrailer, { name: "a.csv", mimeType: "text/csv" }).format).toBe(
      "csv",
    );
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

  it.each(["II*\u0000rest", "MM\u0000*rest", "GIF87a", "GIF89a"])(
    "rejects unsupported image magic %j even when declared as CSV",
    (header) => {
      expect(() =>
        detectDocumentFormat(Buffer.from(header, "latin1"), {
          name: "data.csv",
          mimeType: "text/csv",
        }),
      ).toThrow(UnsupportedDocumentTypeError);
    },
  );
});
