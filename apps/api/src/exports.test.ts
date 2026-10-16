import ExcelJS from "exceljs";
import JSZip from "jszip";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { parseTable, toCellValue } from "./exports.js";
import { createTestHarness, VISITOR_A } from "./testing/harness.js";

function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];

    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

async function seedExportCaseAsync() {
  const harness = createTestHarness();
  const { store } = harness;
  const caseRecord = await store.cases.createCaseAsync({
    title: "MSME dispute with Acme Traders",
    useCase: "msme-payment",
    visitorId: VISITOR_A,
    status: "completed",
  });
  const evidence = {
    id: "e-invoice",
    sourceRef: "invoices.xlsx Invoices!B4:F4",
    description: "Invoice INV-104 for Rs. 2,40,000",
    excerpt: "INV-104 | 2024-01-15 | 240000",
    documentId: "doc-invoices",
    location: { sheet: "Invoices", cellRange: "B4:F4" },
    confidence: "high" as const,
  };

  await store.tasks.createTaskAsync({
    id: "t1",
    caseId: caseRecord.id,
    title: "Reconcile invoices",
    assignedRole: "payment-reconciliation",
    status: "completed",
    attempts: 1,
  });
  await store.evidence.addEvidenceAsync(caseRecord.id, evidence);
  await store.evidence.addEvidenceAsync(caseRecord.id, {
    id: "e-ledger",
    sourceRef: "ledger.csv rows 12-14",
    description: "Ledger shows no receipt against INV-109",
    location: { rowRange: { start: 12, end: 14 } },
  });
  await store.findings.addFindingAsync(caseRecord.id, {
    id: "f1",
    taskId: "t1",
    attempt: 1,
    summary: "INV-104 is unpaid after 45 days",
    severity: "high",
    confidence: "high",
    evidence: [evidence],
  });
  await store.deliverables.saveDeliverableAsync({
    id: "deliverable-primary",
    caseId: caseRecord.id,
    title: "Payment dispute case pack",
    format: "document",
    content: "Prepared for the MSME Facilitation Council.",
    sections: [
      {
        id: "t1-section-1",
        title: "Statement of claim",
        kind: "text",
        content: "AI drafted claim paragraph.",
        producedByRole: "case-preparation",
        findingIds: ["f1"],
      },
      {
        id: "t1-section-2",
        title: "Outstanding invoices",
        kind: "table",
        content: [
          "| Invoice | Date | Amount |",
          "| --- | --- | ---: |",
          "| INV-104 | 2024-01-15 | 2,40,000 |",
          "| 00109 | 2024-02-02 | 75,500 |",
          "| Acme \\| West | 2024-02-10 | Rs. 1,200.50 |",
        ].join("\n"),
        producedByRole: "payment-reconciliation",
        evidenceIds: ["e-invoice", "e-ledger"],
      },
    ],
  });

  const base = `/cases/${caseRecord.id}/deliverables/deliverable-primary`;

  await request(harness.app)
    .patch(`${base}/sections/t1-section-1`)
    .send({ editedContent: "Reviewer revised claim for **Rs. 2,40,000** plus interest." })
    .expect(200);

  return { ...harness, caseRecord, base };
}

describe("deliverable exports", () => {
  it("exports a .docx with reviewer edits and the evidence appendix", async () => {
    const { app, base } = await seedExportCaseAsync();
    const response = await binary(
      request(app).get(`${base}/export`).query({ format: "docx" }),
    ).expect(200);

    expect(response.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers["content-disposition"]).toContain(
      'attachment; filename="payment-dispute-case-pack.docx"',
    );

    const zip = await JSZip.loadAsync(response.body as Buffer);
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const text = xml.replace(/<[^>]+>/g, "");

    expect(text).toContain("Reviewer revised claim for ");
    expect(text).toContain("Rs. 2,40,000");
    expect(text).not.toContain("AI drafted claim paragraph.");
    expect(text).toContain("edited by reviewer");
    expect(text).toContain("Evidence: E1");
    expect(text).toContain("Evidence appendix");
    expect(text).toContain("invoices.xlsx Invoices!B4:F4");
    expect(text).toContain("Invoices!B4:F4");
    expect(text).toContain("Prepared for the MSME Facilitation Council.");
    expect(text).toContain("Evidence: E1, E2");
    expect(text).toContain("ledger.csv rows 12-14");
    expect(text).toContain("Acme | West");
  });

  it("exports a .xlsx with sections, table sheets, and the evidence appendix", async () => {
    const { app, base } = await seedExportCaseAsync();
    const response = await binary(
      request(app).get(`${base}/export`).query({ format: "xlsx" }),
    ).expect(200);
    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.load(response.body as Buffer);

    const sections = workbook.getWorksheet("Sections");
    const table = workbook.getWorksheet("Outstanding invoices");
    const appendix = workbook.getWorksheet("Evidence");

    expect(sections?.getRow(2).getCell(1).value).toBe("Payment dispute case pack");
    expect(sections?.getRow(2).getCell(6).value).toBe(
      "Prepared for the MSME Facilitation Council.",
    );
    expect(sections?.getRow(3).getCell(1).value).toBe("Statement of claim");
    expect(sections?.getRow(3).getCell(5).value).toBe("yes");
    expect(sections?.getRow(3).getCell(6).value).toBe(
      "Reviewer revised claim for **Rs. 2,40,000** plus interest.",
    );
    expect(sections?.getRow(3).getCell(8).value).toBe("E1");
    expect(sections?.getRow(4).getCell(8).value).toBe("E1, E2");
    expect(table?.getRow(1).values).toEqual([undefined, "Invoice", "Date", "Amount"]);
    expect(table?.getRow(2).values).toEqual([undefined, "INV-104", "2024-01-15", 240000]);
    expect(table?.getRow(3).values).toEqual([undefined, "00109", "2024-02-02", 75500]);
    expect(table?.getRow(4).values).toEqual([undefined, "Acme | West", "2024-02-10", 1200.5]);
    expect(appendix?.getRow(3).getCell(2).value).toBe("ledger.csv rows 12-14");
    expect(appendix?.getRow(2).values).toEqual([
      undefined,
      "E1",
      "invoices.xlsx Invoices!B4:F4",
      "Invoices!B4:F4",
      "Invoice INV-104 for Rs. 2,40,000",
      "INV-104 | 2024-01-15 | 240000",
      "high",
    ]);
  });

  it("exports JSON with effective content, findings, and the appendix", async () => {
    const { app, base } = await seedExportCaseAsync();
    const response = await request(app).get(`${base}/export`).query({ format: "json" }).expect(200);

    expect(response.body.deliverable.sections[0]).toMatchObject({
      effectiveContent: "Reviewer revised claim for **Rs. 2,40,000** plus interest.",
      editedByReviewer: true,
      evidenceRefs: ["E1"],
    });
    expect(response.body.findings.map((item: { id: string }) => item.id)).toEqual(["f1"]);
    expect(response.body.evidenceAppendix).toEqual([
      expect.objectContaining({ ref: "E1", id: "e-invoice" }),
      expect.objectContaining({ ref: "E2", id: "e-ledger" }),
    ]);
  });

  it("parses markdown and JSON tables", () => {
    expect(parseTable("Intro\n| A | B |\n|---|---|\n| 1 | 2 |\nOutro")).toEqual({
      header: ["A", "B"],
      rows: [["1", "2"]],
    });
    expect(parseTable('[{"month":"Jan","revenue":10}]')).toEqual({
      header: ["month", "revenue"],
      rows: [["Jan", "10"]],
    });
    expect(parseTable('{"columns":[{"name":"x"}],"rows":[[1],[2]]}')).toEqual({
      header: ["x"],
      rows: [["1"], ["2"]],
    });
    expect(parseTable("No table here.")).toBeUndefined();
    expect(parseTable("| Party | Amount |\n|---|---|\n| Acme \\| West | 10 |")?.rows).toEqual([
      ["Acme | West", "10"],
    ]);
  });

  it("converts plain amounts but keeps identifiers as text", () => {
    expect(toCellValue("2,40,000")).toBe(240000);
    expect(toCellValue("Rs. 1,200.50")).toBe(1200.5);
    expect(toCellValue("-75")).toBe(-75);
    expect(toCellValue("0.5")).toBe(0.5);
    expect(toCellValue("00104")).toBe("00104");
    expect(toCellValue("123 456")).toBe("123 456");
    expect(toCellValue("2024-01-15")).toBe("2024-01-15");
    expect(toCellValue("1234567890123456789")).toBe("1234567890123456789");
  });
});
