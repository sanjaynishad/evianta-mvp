import { company, regions } from "../data/business.js";
import { distributorBudget, monthLabel, onlineTargets } from "../data/sales.js";
import {
  ASSESSMENT_YEAR,
  FINANCIAL_YEAR,
  advanceTaxChallans,
  assessee,
  computation,
  form26AsEntries,
  returnFiling,
  summarizeByDeductor,
  tdsEntries,
  totalTds,
  type TdsEntry,
} from "../data/tax.js";
import {
  createDemoConnector,
  CSV_MIME_TYPE,
  PDF_MIME_TYPE,
  textFile,
  type DemoItem,
} from "../demo.js";
import { formatDashedDate, formatIndianNumber, toCsv, type CsvCell } from "../format.js";
import { createTextPdfAsync, pdfColumns, type PdfBlock, type PdfColumn } from "../pdf.js";

const FORM_26AS_UPDATED_ON = "2026-09-30";

function noTransactions(title: string): PdfBlock[] {
  return [
    { kind: "space", height: 6 },
    { kind: "text", text: title, bold: true },
    { kind: "text", text: "No Transactions Present" },
  ];
}

function form26AsPdfAsync(): Promise<Buffer> {
  const entries = form26AsEntries();
  const summaries = summarizeByDeductor(entries);
  const summaryColumns: PdfColumn[] = [
    { x: pdfColumns.pageLeft },
    { x: 72 },
    { x: 250 },
    { x: 410, align: "right" },
    { x: 480, align: "right" },
    { x: pdfColumns.pageRight, align: "right" },
  ];
  const detailColumns: PdfColumn[] = [
    { x: 60 },
    { x: 86 },
    { x: 130 },
    { x: 205 },
    { x: 250 },
    { x: 410, align: "right" },
    { x: 480, align: "right" },
    { x: pdfColumns.pageRight, align: "right" },
  ];
  const challanColumns: PdfColumn[] = [
    { x: pdfColumns.pageLeft },
    { x: 72 },
    { x: 160 },
    { x: 300 },
    { x: 380 },
    { x: pdfColumns.pageRight, align: "right" },
  ];
  const detailRows = (deductorEntries: readonly TdsEntry[]): PdfBlock[] =>
    deductorEntries.map((entry, index) => ({
      kind: "row",
      size: 8.5,
      cells: [
        String(index + 1),
        entry.deductor.section,
        formatDashedDate(entry.date),
        "F",
        formatDashedDate(entry.bookedOn),
        formatIndianNumber(entry.grossAmount),
        formatIndianNumber(entry.tds),
        formatIndianNumber(entry.tds),
      ],
      columns: detailColumns,
    }));

  const pageOne: PdfBlock[] = [
    { kind: "text", text: "Annual Tax Statement", size: 15, bold: true },
    { kind: "text", text: "Form 26AS under section 203AA of the Income-tax Act, 1961" },
    { kind: "space", height: 6 },
    { kind: "text", text: `Permanent Account Number (PAN): ${assessee.pan}` },
    { kind: "text", text: "Current Status of PAN: Active" },
    {
      kind: "text",
      text: `Financial Year: ${FINANCIAL_YEAR}    Assessment Year: ${ASSESSMENT_YEAR}`,
    },
    { kind: "text", text: `Name of Assessee: ${assessee.name}` },
    { kind: "text", text: `Address of Assessee: ${company.addressLines.join(", ")}` },
    { kind: "text", text: `Data updated till: ${formatDashedDate(FORM_26AS_UPDATED_ON)}` },
    { kind: "space", height: 10 },
    { kind: "text", text: "PART I - Details of Tax Deducted at Source", size: 11, bold: true },
    {
      kind: "row",
      size: 8.5,
      bold: true,
      cells: [
        "Sr.",
        "Name of Deductor",
        "TAN of Deductor",
        "Amount Paid/Credited",
        "Tax Deducted",
        "TDS Deposited",
      ],
      columns: summaryColumns,
    },
    { kind: "rule" },
    ...summaries.map((summary, index): PdfBlock => ({
      kind: "row",
      size: 8.5,
      cells: [
        String(index + 1),
        summary.deductor.name,
        summary.deductor.tan,
        formatIndianNumber(summary.grossAmount),
        formatIndianNumber(summary.tds),
        formatIndianNumber(summary.tds),
      ],
      columns: summaryColumns,
    })),
    { kind: "rule" },
    {
      kind: "row",
      size: 8.5,
      bold: true,
      cells: [
        "",
        "Total",
        "",
        formatIndianNumber(entries.reduce((sum, entry) => sum + entry.grossAmount, 0)),
        formatIndianNumber(totalTds(entries)),
        formatIndianNumber(totalTds(entries)),
      ],
      columns: summaryColumns,
    },
    { kind: "space", height: 8 },
    { kind: "text", text: "Transaction details", bold: true },
    ...summaries.flatMap((summary, index): PdfBlock[] => [
      { kind: "space", height: 4 },
      {
        kind: "text",
        size: 9,
        bold: true,
        text: `${index + 1}. ${summary.deductor.name} (TAN ${summary.deductor.tan})`,
      },
      {
        kind: "row",
        size: 8,
        bold: true,
        cells: [
          "Sr.",
          "Section",
          "Transaction Date",
          "Status",
          "Date of Booking",
          "Amount Paid/Credited",
          "Tax Deducted",
          "TDS Deposited",
        ],
        columns: detailColumns,
      },
      ...detailRows(entries.filter((entry) => entry.deductor.tan === summary.deductor.tan)),
    ]),
  ];
  const pageTwo: PdfBlock[] = [
    ...noTransactions("PART II - Details of Tax Deducted at Source for 15G / 15H"),
    ...noTransactions(
      "PART IV - Details of Tax Deducted at Source u/s 194IA / 194IB / 194M / 194S (for seller or payee)",
    ),
    ...noTransactions("PART VI - Details of Tax Collected at Source"),
    ...noTransactions("PART VII - Details of Paid Refund"),
    { kind: "space", height: 10 },
    { kind: "text", text: "Details of Tax Paid (other than TDS or TCS)", size: 11, bold: true },
    {
      kind: "row",
      size: 8.5,
      bold: true,
      cells: ["Sr.", "Minor Head", "BSR Code", "Date of Deposit", "Challan Serial No", "Tax (Rs.)"],
      columns: challanColumns,
    },
    { kind: "rule" },
    ...advanceTaxChallans.map((challan, index): PdfBlock => ({
      kind: "row",
      size: 8.5,
      cells: [
        String(index + 1),
        "100 (Advance Tax)",
        challan.bsrCode,
        formatDashedDate(challan.date),
        challan.challanNumber,
        formatIndianNumber(challan.amount),
      ],
      columns: challanColumns,
    })),
    { kind: "space", height: 10 },
    {
      kind: "text",
      text: "Legend for Status of Booking: F - Final, U - Unmatched, P - Provisional",
      size: 8,
    },
  ];

  return createTextPdfAsync({
    title: `Form 26AS AY ${ASSESSMENT_YEAR}`,
    author: "Synthetic demo data",
    subject: `Annual tax statement for PAN ${assessee.pan}`,
    createdOn: FORM_26AS_UPDATED_ON,
    pages: [pageOne, pageTwo],
  });
}

function computationPdfAsync(): Promise<Buffer> {
  const figures = computation();
  const amountColumns: PdfColumn[] = [
    { x: pdfColumns.pageLeft },
    { x: 440, align: "right" },
    { x: pdfColumns.pageRight, align: "right" },
  ];
  const row = (label: string, inner?: number, outer?: number, bold = false): PdfBlock => ({
    kind: "row",
    bold,
    cells: [
      label,
      inner === undefined ? "" : formatAmount(inner),
      outer === undefined ? "" : formatAmount(outer),
    ],
    columns: amountColumns,
  });
  const scheduleColumns: PdfColumn[] = [
    { x: pdfColumns.pageLeft },
    { x: 120 },
    { x: 290 },
    { x: 440, align: "right" },
    { x: pdfColumns.pageRight, align: "right" },
  ];
  const claimed = summarizeByDeductor(tdsEntries);

  return createTextPdfAsync({
    title: `Computation of total income AY ${ASSESSMENT_YEAR}`,
    author: company.name,
    subject: `Return of income for AY ${ASSESSMENT_YEAR}`,
    createdOn: returnFiling.filedOn,
    pages: [
      [
        { kind: "text", text: company.name, size: 14, bold: true },
        { kind: "text", text: company.addressLines.join(", ") },
        {
          kind: "text",
          text: `PAN: ${assessee.pan}    Status: ${assessee.status}    Assessment Year: ${ASSESSMENT_YEAR}    Financial Year: ${FINANCIAL_YEAR}`,
        },
        {
          kind: "text",
          text: `Return filed on ${formatDashedDate(returnFiling.filedOn)} under section ${returnFiling.section}, Acknowledgement No. ${returnFiling.acknowledgementNumber}`,
        },
        { kind: "space", height: 10 },
        { kind: "text", text: "Computation of Total Income", size: 12, bold: true },
        { kind: "row", bold: true, cells: ["Particulars", "Rs.", "Rs."], columns: amountColumns },
        { kind: "rule" },
        row("Income from business or profession", undefined, undefined, true),
        row("Net profit as per profit and loss account", figures.netProfit),
        row("Less: Interest on fixed deposits considered separately", -figures.fdInterest),
        row("Add: Depreciation as per books of account", figures.bookDepreciation),
        row("Less: Depreciation allowable under section 32", -figures.taxDepreciation),
        row("Income from business", undefined, figures.businessIncome),
        { kind: "space", height: 4 },
        row("Income from other sources", undefined, undefined, true),
        row(
          "Interest on fixed deposits (Konkan Mercantile Bank Ltd)",
          undefined,
          figures.fdInterest,
        ),
        { kind: "rule" },
        row("Gross total income", undefined, figures.grossTotalIncome, true),
        row("Less: Deductions under Chapter VI-A", undefined, 0),
        row("Total income (rounded off under section 288A)", undefined, figures.totalIncome, true),
        { kind: "space", height: 6 },
        row("Tax on total income at 30%", undefined, figures.tax),
        row("Add: Health and education cess at 4%", undefined, figures.cess),
        row("Total tax liability", undefined, figures.totalTax, true),
        row("Less: Tax deducted at source (Schedule TDS)", undefined, -figures.tdsClaimed),
        row("Less: Advance tax (Schedule IT)", undefined, -figures.advanceTax),
        { kind: "rule" },
        row("Tax payable / (refundable)", undefined, figures.balancePayable, true),
        { kind: "space", height: 12 },
        {
          kind: "text",
          text: "Schedule TDS: tax deducted at source claimed",
          size: 11,
          bold: true,
        },
        {
          kind: "row",
          bold: true,
          size: 9,
          cells: ["TAN", "Name of deductor", "Section", "Income offered", "TDS claimed"],
          columns: scheduleColumns,
        },
        { kind: "rule" },
        ...claimed.map((summary): PdfBlock => ({
          kind: "row",
          size: 9,
          cells: [
            summary.deductor.tan,
            summary.deductor.name,
            summary.deductor.section,
            formatIndianNumber(summary.grossAmount),
            formatIndianNumber(summary.tds),
          ],
          columns: scheduleColumns,
        })),
        { kind: "rule" },
        {
          kind: "row",
          bold: true,
          size: 9,
          cells: [
            "Total",
            "",
            "",
            formatIndianNumber(claimed.reduce((sum, summary) => sum + summary.grossAmount, 0)),
            formatIndianNumber(figures.tdsClaimed),
          ],
          columns: scheduleColumns,
        },
        { kind: "space", height: 12 },
        { kind: "text", text: "Schedule IT: advance tax paid", size: 11, bold: true },
        ...advanceTaxChallans.map((challan): PdfBlock => ({
          kind: "row",
          size: 9,
          cells: [
            `BSR ${challan.bsrCode}`,
            `Challan ${challan.challanNumber}`,
            formatDashedDate(challan.date),
            "",
            formatIndianNumber(challan.amount),
          ],
          columns: scheduleColumns,
        })),
        { kind: "space", height: 16 },
        { kind: "text", text: `For ${company.name}` },
        { kind: "text", text: `${company.partner}, Managing Partner` },
      ],
    ],
  });
}

function formatAmount(value: number): string {
  if (value === 0) {
    return "Nil";
  }

  return value < 0 ? `(${formatIndianNumber(-value)})` : formatIndianNumber(value);
}

function udyamPdfAsync(): Promise<Buffer> {
  const labelColumns: PdfColumn[] = [{ x: pdfColumns.pageLeft }, { x: 290 }];
  const field = (label: string, value: string): PdfBlock => ({
    kind: "row",
    size: 9,
    cells: [label, value],
    columns: labelColumns,
  });
  const classificationColumns: PdfColumn[] = [
    { x: pdfColumns.pageLeft },
    { x: 100 },
    { x: 230 },
    { x: 360 },
  ];
  const classifications: Array<[string, string]> = [
    ["2021-22", "12/08/2021"],
    ["2023-24", "18/05/2023"],
    ["2025-26", "21/05/2025"],
    ["2026-27", "19/05/2026"],
  ];

  return createTextPdfAsync({
    title: "Udyam Registration Certificate",
    author: "Synthetic demo data",
    subject: company.udyamNumber,
    createdOn: "2026-05-19",
    pages: [
      [
        { kind: "text", text: "Government of India", bold: true },
        { kind: "text", text: "Ministry of Micro, Small and Medium Enterprises" },
        { kind: "space", height: 8 },
        { kind: "text", text: "UDYAM REGISTRATION CERTIFICATE", size: 15, bold: true },
        { kind: "space", height: 8 },
        field("UDYAM REGISTRATION NUMBER", company.udyamNumber),
        field("NAME OF ENTERPRISE", company.name.toUpperCase()),
        { kind: "space", height: 6 },
        { kind: "text", text: "TYPE OF ENTERPRISE", bold: true },
        {
          kind: "row",
          bold: true,
          cells: ["SNo.", "Classification Year", "Enterprise Type", "Classification Date"],
          columns: classificationColumns,
        },
        ...classifications.map(([year, date], index): PdfBlock => ({
          kind: "row",
          cells: [String(index + 1), year, "Micro", date],
          columns: classificationColumns,
        })),
        { kind: "space", height: 6 },
        field("MAJOR ACTIVITY", "MANUFACTURING"),
        field("SOCIAL CATEGORY OF ENTREPRENEUR", "GENERAL"),
        field("NAME OF UNIT(S)", `${company.name}, Bhosari unit`),
        field("OFFICIAL ADDRESS OF ENTERPRISE", company.addressLines[0]),
        field("", company.addressLines[1]),
        field("DATE OF INCORPORATION / REGISTRATION", "05/04/2016"),
        field("DATE OF COMMENCEMENT OF PRODUCTION", "01/07/2016"),
        field(
          "NATIONAL INDUSTRY CLASSIFICATION",
          "22 - Manufacture of rubber and plastics products",
        ),
        field("", "2220 - Manufacture of plastics products"),
        field("", "22209 - Manufacture of other plastics products n.e.c."),
        field("DATE OF UDYAM REGISTRATION", "12/08/2021"),
        { kind: "space", height: 14 },
        {
          kind: "text",
          size: 8.5,
          text: "Disclaimer: This is a computer generated statement, no signature required.",
        },
      ],
    ],
  });
}

function targetsCsv(): string {
  const months = [...new Set(onlineTargets.map((target) => target.month))];
  const rows: CsvCell[][] = [];

  for (const month of months) {
    for (const region of regions) {
      const distributor = distributorBudget.find(
        (figure) => figure.month === month && figure.region === region,
      );
      const online = onlineTargets.find(
        (figure) => figure.month === month && figure.region === region,
      );

      rows.push([monthLabel(month), "Distributors", region, distributor?.amount ?? null]);
      rows.push([monthLabel(month), "Online store", region, online?.amount ?? null]);
    }
  }

  return toCsv(["Month", "Channel", "Region", "Target (Rs)"], rows);
}

const items: Record<string, DemoItem> = {
  "form-26as": {
    label: `Form 26AS: AY ${ASSESSMENT_YEAR}`,
    detail: `PAN ${assessee.pan}, ${summarizeByDeductor(form26AsEntries()).length} deductors, TDS Rs. ${formatIndianNumber(totalTds(form26AsEntries()))}`,
    fileName: "form26as-ay2025-26.pdf",
    mimeType: PDF_MIME_TYPE,
    buildAsync: form26AsPdfAsync,
  },
  computation: {
    label: `Computation of income: AY ${ASSESSMENT_YEAR}`,
    detail: `${company.name}, return filed ${formatDashedDate(returnFiling.filedOn)}`,
    fileName: "computation-of-income-ay2025-26.pdf",
    mimeType: PDF_MIME_TYPE,
    buildAsync: computationPdfAsync,
  },
  "udyam-certificate": {
    label: `Udyam certificate: ${company.name}`,
    detail: `${company.udyamNumber}, Micro, Manufacturing`,
    fileName: "udyam-certificate-sharma-homeware.pdf",
    mimeType: PDF_MIME_TYPE,
    buildAsync: udyamPdfAsync,
  },
  "sales-targets": {
    label: "Sales targets: Jul to Sep 2026",
    detail: "Monthly targets by channel and region",
    fileName: "monthly-targets-by-region-jul-sep-2026.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(targetsCsv()),
  },
};

export const googleDriveConnector = createDemoConnector("google-drive", items);
