import { describe, expect, it } from "vitest";

import { createDocx, createZip, wordDocumentXml } from "./__fixtures__/fixtures.js";
import { parseDocx } from "./docx.js";

const options = { dateOrder: "dmy" as const };

function run(text: string, extra = ""): string {
  return `<w:r>${extra}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function paragraph(content: string, properties = ""): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;
}

function cell(text: string, properties = ""): string {
  return `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ""}${paragraph(run(text))}</w:tc>`;
}

function table(rows: string[][]): string {
  return `<w:tbl><w:tblPr/>${rows.map((row) => `<w:tr>${row.join("")}</w:tr>`).join("")}</w:tbl>`;
}

function heading(text: string): string {
  return paragraph(run(text), '<w:pStyle w:val="Heading1"/>');
}

describe("parseDocx", () => {
  it("reads paragraphs, tabs, line breaks, and XML entities", () => {
    const result = parseDocx(
      createDocx(
        paragraph(
          `<w:r><w:t>Invoice</w:t><w:tab/><w:t xml:space="preserve">KF-1 </w:t><w:br/><w:t>due &amp; unpaid &#8377;</w:t></w:r>`,
        ) + paragraph(run("Second paragraph")),
      ),
      options,
    );

    expect(result).toEqual({
      pages: ["Invoice\tKF-1 \ndue & unpaid \u20b9\nSecond paragraph\n"],
      tables: [],
      warnings: [],
    });
  });

  it("keeps inserted text and field results but drops deletions and field codes", () => {
    const result = parseDocx(
      createDocx(
        paragraph(
          [
            `<w:ins w:id="1">${run("added ")}</w:ins>`,
            `<w:del w:id="2"><w:r><w:delText>removed </w:delText></w:r></w:del>`,
            `<w:r><w:fldChar w:fldCharType="begin"/></w:r>`,
            `<w:r><w:instrText> PAGE </w:instrText></w:r>`,
            `<w:r><w:fldChar w:fldCharType="separate"/></w:r>`,
            run("3"),
            `<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
            `<w:hyperlink w:anchor="x">${run(" link")}</w:hyperlink>`,
          ].join(""),
        ),
      ),
      options,
    );

    expect(result.pages).toEqual(["added 3 link\n"]);
  });

  it("starts pages at explicit, before-paragraph, and rendered page breaks", () => {
    const result = parseDocx(
      createDocx(
        [
          paragraph(run("One")),
          paragraph('<w:r><w:br w:type="page"/></w:r>'),
          paragraph(run("Two", "<w:lastRenderedPageBreak/>")),
          paragraph(run("Three"), "<w:pageBreakBefore/>"),
          paragraph(run("Still three"), '<w:pageBreakBefore w:val="0"/>'),
        ].join(""),
      ),
      options,
    );

    expect(result.pages.map((page) => page.trim())).toEqual(["One", "Two", "Three\nStill three"]);
  });

  it("splits long pages by size", () => {
    const result = parseDocx(createDocx(paragraph(run("alpha beta gamma"))), {
      ...options,
      maxChars: 8,
    });

    expect(result.pages).toEqual(["alpha ", "beta ", "gamma\n"]);
  });

  it("reads tables with merged cells, names them after headings, and keeps their text", () => {
    const result = parseDocx(
      createDocx(
        [
          heading("Invoices"),
          table([
            [cell("Invoice"), cell("Date"), cell("Amount")],
            [cell("INV-1"), cell("05/01/2024"), cell("1,200.50")],
            [cell("Total", '<w:gridSpan w:val="2"/>'), cell("1,200.50")],
          ]),
          paragraph(run("Parties"), '<w:outlineLvl w:val="1"/>'),
          table([
            [cell("Party"), cell("Item")],
            [cell("Apex", '<w:vMerge w:val="restart"/>'), cell("Bolts")],
            [cell("ignored", "<w:vMerge/>"), cell("Nuts")],
          ]),
        ].join(""),
      ),
      options,
    );

    expect(result.tables).toEqual([
      {
        name: "Invoices",
        pageIndex: 1,
        range: "A1:C3",
        columns: [
          { name: "Invoice", type: "string" },
          { name: "Date", type: "date" },
          { name: "Amount", type: "number" },
        ],
        rows: [
          ["INV-1", "2024-01-05", 1200.5],
          ["Total", null, 1200.5],
        ],
      },
      {
        name: "Parties",
        pageIndex: 1,
        range: "A1:B3",
        columns: [
          { name: "Party", type: "string" },
          { name: "Item", type: "string" },
        ],
        rows: [
          ["Apex", "Bolts"],
          [null, "Nuts"],
        ],
      },
    ]);
    expect(result.pages[0]).toContain("INV-1\t05/01/2024\t1,200.50\n");
    expect(result.pages[0]).toContain("Total\t\t1,200.50\n");
  });

  it("flattens nested tables into the cell and keeps one-row tables as text only", () => {
    const nested = table([[cell("a"), cell("b")]]);
    const result = parseDocx(
      createDocx(
        [
          table([[cell("Letterhead")]]),
          table([
            [cell("Item"), cell("Detail")],
            [cell("Box"), `<w:tc>${paragraph(run("Lines:"))}${nested}</w:tc>`],
          ]),
        ].join(""),
      ),
      options,
    );

    expect(result.pages[0]?.startsWith("Letterhead\n")).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ name: "Table 1", rows: [["Box", "Lines: a b"]] });
  });

  it("reads text boxes once, after their anchor paragraph", () => {
    const box = `<w:txbxContent>${paragraph(run("Boxed"))}</w:txbxContent>`;
    const result = parseDocx(
      createDocx(
        paragraph(
          `${run("Anchor")}<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx>${box}</wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox>${box}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`,
        ),
      ),
      options,
    );

    expect(result.pages).toEqual(["Anchor\nBoxed\n"]);
  });

  it("warns about unread headers and empty documents", () => {
    const result = parseDocx(
      createDocx("", [{ name: "word/header1.xml", data: "<w:hdr/>" }]),
      options,
    );

    expect(result.pages).toEqual([""]);
    expect(result.warnings).toEqual([
      "The file has no text.",
      "Headers and footers were not read.",
    ]);
  });

  it("follows the package relationship to the main document part", () => {
    const docx = createZip([
      {
        name: "_rels/.rels",
        data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/main.xml"/></Relationships>',
      },
      { name: "word/main.xml", data: wordDocumentXml(paragraph(run("Main part"))), store: true },
    ]);

    expect(parseDocx(docx, options).pages).toEqual(["Main part\n"]);
  });

  it("does not expand entities and rejects document type declarations", () => {
    expect(parseDocx(createDocx(paragraph(run("&unknown;"))), options).pages).toEqual([
      "&unknown;\n",
    ]);

    const withDoctype = createZip([
      {
        name: "word/document.xml",
        data: `<!DOCTYPE w:document [<!ENTITY boom "x">]>${wordDocumentXml(paragraph(run("&boom;")))}`,
      },
    ]);

    expect(() => parseDocx(withDoctype, options)).toThrow(/Document type declarations/);
  });

  it("rejects parts that inflate past the size limit, stored or deflated", () => {
    const body = paragraph(run("x".repeat(500)));

    expect(() => parseDocx(createDocx(body), { ...options, maxPartBytes: 400 })).toThrow(
      RangeError,
    );
    expect(() =>
      parseDocx(
        createZip([{ name: "word/document.xml", data: wordDocumentXml(body), store: true }]),
        {
          ...options,
          maxPartBytes: 400,
        },
      ),
    ).toThrow(RangeError);
  });

  it("rejects archives that are not Word documents or are malformed", () => {
    expect(() => parseDocx(Buffer.from("not a zip"), options)).toThrow(/not a valid zip/);
    expect(() =>
      parseDocx(createZip([{ name: "ppt/presentation.xml", data: "<p/>" }]), options),
    ).toThrow(/no "word\/document.xml" part/);
    expect(() =>
      parseDocx(createZip([{ name: "word/document.xml", data: "<w:document><w:body>" }]), options),
    ).toThrow(/malformed/);
    expect(() =>
      parseDocx(createZip([{ name: "word/document.xml", data: "<root/>" }]), options),
    ).toThrow(/not a Word document/);
  });
});
