import { createMockAi } from "@evianta/ai";
import { describe, expect, it } from "vitest";

import { documentMetadata } from "./__fixtures__/fixtures.js";
import { extractDocumentAsync } from "./extract.js";
import { parseEmail, parsePlainText } from "./text.js";

function crlf(lines: string[]): string {
  return lines.join("\r\n");
}

describe("parsePlainText", () => {
  it("normalizes line endings", () => {
    expect(parsePlainText("one\r\ntwo\rthree\n")).toEqual({
      text: "one\ntwo\nthree\n",
      warnings: [],
    });
  });
});

describe("parseEmail", () => {
  it("keeps the main headers and the plain body", () => {
    const raw = crlf([
      "Received: from mx.example.com",
      "Message-ID: <abc@example.com>",
      "From: Asha Rao <asha@example.com>",
      "To: tax@example.com",
      "Subject: Notice under",
      " section 143(1)",
      "Date: Mon, 3 Jun 2024 10:15:00 +0530",
      "Cc: ca@example.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please find the notice attached.",
      "Regards",
    ]);

    expect(parseEmail(raw)).toEqual({
      text: [
        "From: Asha Rao <asha@example.com>",
        "To: tax@example.com",
        "Cc: ca@example.com",
        "Date: Mon, 3 Jun 2024 10:15:00 +0530",
        "Subject: Notice under section 143(1)",
        "",
        "Please find the notice attached.",
        "Regards",
      ].join("\n"),
      warnings: [],
    });
  });

  it("uses text/plain parts of multipart messages and decodes their transfer encoding", () => {
    const raw = crlf([
      "From: =?UTF-8?B?Sm9zw6k=?= <jose@example.com>",
      "Subject: =?UTF-8?Q?Re=3A_D=C3=A9claration?=",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "This is a multi-part message in MIME format.",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Total due: =E2=82=B9 48,250 for the d=",
      "eclaration.",
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Total due</p>",
      "--inner--",
      "--outer",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=notes.txt",
      "",
      Buffer.from("Second line\r\nfrom the attachment").toString("base64"),
      "--outer",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjcK",
      "--outer--",
      "",
    ]);

    expect(parseEmail(raw)).toEqual({
      text: [
        "From: Jos\u00e9 <jose@example.com>",
        "Subject: Re: D\u00e9claration",
        "",
        "Total due: \u20b9 48,250 for the declaration.",
        "",
        "Second line",
        "from the attachment",
      ].join("\n"),
      warnings: [],
    });
  });

  it("falls back to the HTML body with a warning when there is no plain text", () => {
    const raw = crlf([
      "From: a@example.com",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Hello &amp; welcome</p><p>Line two</p></body></html>",
    ]);

    expect(parseEmail(raw)).toEqual({
      text: "From: a@example.com\n\nHello & welcome\nLine two",
      warnings: ["The email has no plain-text body; its HTML body was converted to text."],
    });
  });
});

describe("extractDocumentAsync: text", () => {
  it("reads a plain text file into a single parsed page without calling the model", async () => {
    const ai = createMockAi();
    const outcome = await extractDocumentAsync(
      Buffer.from("Line one\r\nLine two\r\n"),
      documentMetadata({ name: "notes.txt", mimeType: "text/plain" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.failedPages).toEqual([]);
    expect(outcome.extraction).toEqual({
      documentId: "doc-1",
      kind: "text",
      method: "parse",
      confidence: 1,
      pages: [{ index: 1, text: "Line one\nLine two\n", method: "parse", confidence: 1 }],
      tables: [],
      warnings: [],
    });
  });

  it("reads an .eml file as headers then body", async () => {
    const outcome = await extractDocumentAsync(
      Buffer.from(crlf(["X-Mailer: test", "Subject: Hello", "", "Body text"])),
      documentMetadata({ name: "mail.eml", mimeType: "message/rfc822" }),
      { ai: createMockAi() },
    );

    expect(outcome.extraction.kind).toBe("text");
    expect(outcome.extraction.pages).toEqual([
      { index: 1, text: "Subject: Hello\n\nBody text", method: "parse", confidence: 1 },
    ]);
  });

  it("warns when the text is not valid UTF-8", async () => {
    const outcome = await extractDocumentAsync(
      Buffer.from("Jos\u00e9", "latin1"),
      documentMetadata({ name: "names.txt", mimeType: "text/plain" }),
      { ai: createMockAi() },
    );

    expect(outcome.extraction.pages[0]?.text).toBe("Jos\u00e9");
    expect(outcome.extraction.warnings).toEqual([
      "The file is not valid UTF-8; it was decoded as Windows-1252.",
    ]);
  });
});
