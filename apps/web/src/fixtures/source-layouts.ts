import type { BoundingBox, PageExtractionMethod, TextSpan } from "@evianta/core";

// Layouts of the synthetic source files under public/fixtures. The same layout drives the
// generated PDFs and the fixture extraction spans, so highlights land on the drawn text.

export interface LayoutLine {
  x: number;
  // Top of the line box, as a fraction of the page height.
  y: number;
  size: number;
  text: string;
  bold?: boolean;
}

export interface LayoutPage {
  lines: LayoutLine[];
  boxes?: BoundingBox[];
  method: PageExtractionMethod;
  confidence: number;
  // Omitted when the extraction did not keep span positions, so the viewer falls back to the
  // rendered text layer.
  keepSpans?: boolean;
}

export interface SourceLayout {
  documentId: string;
  fileName: string;
  pages: LayoutPage[];
}

export const pdfPageSize = { width: 595, height: 842 };

const averageCharWidth = 0.52;

export function lineBox(line: LayoutLine): BoundingBox {
  const width = (line.text.length * line.size * averageCharWidth * (line.bold ? 1.06 : 1)) / 595;
  return {
    x: line.x,
    y: line.y,
    width: Math.min(width, 1 - line.x),
    height: (line.size * 1.25) / pdfPageSize.height,
  };
}

export function layoutSpans(page: LayoutPage): TextSpan[] {
  return page.lines.map((line) => ({
    text: line.text,
    bbox: lineBox(line),
    confidence: page.confidence,
  }));
}

export function layoutText(page: LayoutPage): string {
  return page.lines.map((line) => line.text).join("\n");
}

const syntheticNotice = "SYNTHETIC SAMPLE FOR DEMONSTRATION ONLY. NOT AN OFFICIAL DOCUMENT.";

function footer(page: number, pages: number): LayoutLine[] {
  return [
    { x: 0.08, y: 0.04, size: 8, text: syntheticNotice },
    { x: 0.08, y: 0.94, size: 8, text: `Page ${page} of ${pages}` },
  ];
}

export const noticeLayout: SourceLayout = {
  documentId: "b-doc-notice",
  fileName: "intimation_143_1a_AY2025-26.pdf",
  pages: [
    {
      method: "pdf-text",
      confidence: 0.98,
      keepSpans: true,
      lines: [
        ...footer(1, 2),
        { x: 0.08, y: 0.09, size: 16, text: "Income Tax Department", bold: true },
        { x: 0.08, y: 0.125, size: 11, text: "Centralized Processing Centre, Bengaluru" },
        {
          x: 0.08,
          y: 0.17,
          size: 13,
          text: "Intimation under section 143(1)(a) of the Income-tax Act, 1961",
          bold: true,
        },
        { x: 0.08, y: 0.22, size: 10, text: "Name of assessee: Sharma Textiles" },
        { x: 0.08, y: 0.245, size: 10, text: "PAN: AAAFS0000X" },
        { x: 0.08, y: 0.27, size: 10, text: "Assessment year: 2025-26" },
        { x: 0.08, y: 0.295, size: 10, text: "Date of intimation: 18/09/2026" },
        {
          x: 0.08,
          y: 0.35,
          size: 10,
          text: "The return of income for the above assessment year has been processed.",
        },
        {
          x: 0.08,
          y: 0.375,
          size: 10,
          text: "An adjustment is proposed because the TDS claimed does not match Form 26AS.",
        },
        {
          x: 0.08,
          y: 0.4,
          size: 10,
          text: "Details of the proposed adjustment are given on the next page.",
        },
        {
          x: 0.08,
          y: 0.45,
          size: 10,
          text: "You may respond within 30 days of the date of this intimation.",
        },
      ],
    },
    {
      method: "pdf-text",
      confidence: 0.98,
      keepSpans: true,
      boxes: [{ x: 0.08, y: 0.42, width: 0.84, height: 0.12 }],
      lines: [
        ...footer(2, 2),
        { x: 0.08, y: 0.09, size: 13, text: "Proposed adjustment", bold: true },
        {
          x: 0.08,
          y: 0.13,
          size: 10,
          text: "Adjustment under section 143(1)(a)(iv): credit for tax deducted at source",
        },
        {
          x: 0.08,
          y: 0.17,
          size: 10,
          text: "The credit allowed is limited to the TDS reported in Form 26AS.",
        },
        { x: 0.1, y: 0.432, size: 10, text: "Particulars", bold: true },
        { x: 0.7, y: 0.432, size: 10, text: "Amount (Rs)", bold: true },
        { x: 0.1, y: 0.462, size: 10, text: "TDS claimed in the return" },
        { x: 0.7, y: 0.462, size: 10, text: "1,99,000" },
        { x: 0.1, y: 0.487, size: 10, text: "TDS as per Form 26AS" },
        { x: 0.7, y: 0.487, size: 10, text: "1,86,600" },
        { x: 0.1, y: 0.512, size: 10, text: "Difference", bold: true },
        { x: 0.7, y: 0.512, size: 10, text: "12,400", bold: true },
        {
          x: 0.08,
          y: 0.6,
          size: 10,
          text: "The difference of Rs 12,400 is proposed to be disallowed.",
        },
        {
          x: 0.08,
          y: 0.625,
          size: 10,
          text: "Respond on the e-filing portal under Pending actions, e-Proceedings.",
        },
      ],
    },
  ],
};

const deductorRows: [string, string, string, string][] = [
  ["Bharat Garments Ltd", "MUMB01234E", "6,40,000", "64,000"],
  ["Lakshmi Retail LLP", "CHEN05678F", "4,20,000", "42,000"],
  ["Orient Fashions Pvt Ltd", "DELO09876G", "3,96,000", "39,600"],
  ["Sunrise Traders", "PUNS04321H", "4,10,000", "41,000"],
];

const deductorColumns = [0.08, 0.4, 0.58, 0.76];

export const form26asLayout: SourceLayout = {
  documentId: "b-doc-26as",
  fileName: "form26AS_AY2025-26_scan.pdf",
  pages: [
    {
      method: "ocr",
      confidence: 0.9,
      keepSpans: true,
      lines: [
        ...footer(1, 4),
        { x: 0.08, y: 0.09, size: 16, text: "Form 26AS", bold: true },
        { x: 0.08, y: 0.125, size: 11, text: "Annual Tax Statement under section 203AA" },
        { x: 0.08, y: 0.18, size: 10, text: "PAN of the assessee: AAAFS0000X" },
        { x: 0.08, y: 0.205, size: 10, text: "Name of the assessee: Sharma Textiles" },
        { x: 0.08, y: 0.23, size: 10, text: "Assessment year: 2025-26" },
        { x: 0.08, y: 0.255, size: 10, text: "Financial year: 2024-25" },
      ],
    },
    {
      method: "ocr",
      confidence: 0.88,
      keepSpans: true,
      lines: [
        ...footer(2, 4),
        { x: 0.08, y: 0.09, size: 12, text: "Summary of the statement", bold: true },
        { x: 0.08, y: 0.13, size: 10, text: "Part A: details of tax deducted at source (page 3)" },
        {
          x: 0.08,
          y: 0.155,
          size: 10,
          text: "Part B: details of tax collected at source (page 4)",
        },
        { x: 0.08, y: 0.18, size: 10, text: "Part C: details of tax paid other than TDS or TCS" },
      ],
    },
    {
      method: "ocr",
      confidence: 0.84,
      keepSpans: true,
      boxes: [{ x: 0.06, y: 0.3, width: 0.88, height: 0.36 }],
      lines: [
        ...footer(3, 4),
        {
          x: 0.08,
          y: 0.22,
          size: 12,
          text: "PART A - Details of Tax Deducted at Source",
          bold: true,
        },
        ...["Deductor", "TAN", "Amount paid", "TDS deposited"].map((text, index) => ({
          x: deductorColumns[index]!,
          y: 0.32,
          size: 10,
          text,
          bold: true,
        })),
        ...deductorRows.flatMap((row, rowIndex) =>
          row.map((text, index) => ({
            x: deductorColumns[index]!,
            y: 0.37 + rowIndex * 0.05,
            size: 10,
            text,
          })),
        ),
        { x: 0.08, y: 0.61, size: 10, text: "Total TDS", bold: true },
        { x: 0.76, y: 0.61, size: 10, text: "1,86,600", bold: true },
      ],
    },
    {
      method: "ocr",
      confidence: 0.86,
      keepSpans: true,
      lines: [
        ...footer(4, 4),
        {
          x: 0.08,
          y: 0.09,
          size: 12,
          text: "PART B - Details of Tax Collected at Source",
          bold: true,
        },
        { x: 0.08, y: 0.13, size: 10, text: "No transactions present" },
      ],
    },
  ],
};

export const clientNoteLayout: SourceLayout = {
  documentId: "b-doc-note",
  fileName: "client_note_tds_certificates.jpg",
  pages: [
    {
      method: "handwriting",
      confidence: 0.58,
      keepSpans: true,
      lines: [
        { x: 0.1, y: 0.07, size: 28, text: "Note for CA - 1 Oct" },
        { x: 0.1, y: 0.21, size: 34, text: "Mehta Exports - TDS cert" },
        { x: 0.1, y: 0.29, size: 34, text: "PAN AAKPS1234Q (check)" },
        { x: 0.1, y: 0.37, size: 30, text: "TDS 12,400 on 1,24,000" },
        { x: 0.1, y: 0.58, size: 28, text: "Sent Form 16A copies by email" },
        { x: 0.1, y: 0.66, size: 28, text: "Ask Mehta to correct the PAN" },
      ],
    },
  ],
};

function invoicePage(
  number: string,
  date: string,
  amount: string,
  pageNumber: number,
  accepted?: string,
): LayoutPage {
  return {
    method: accepted ? "ocr" : "pdf-text",
    confidence: accepted ? 0.82 : 0.97,
    keepSpans: true,
    boxes: [
      { x: 0.08, y: 0.36, width: 0.84, height: 0.16 },
      ...(accepted ? [{ x: 0.55, y: 0.78, width: 0.35, height: 0.12 }] : []),
    ],
    lines: [
      ...footer(pageNumber, 4),
      { x: 0.08, y: 0.09, size: 16, text: "Kaveri Fabricators", bold: true },
      { x: 0.08, y: 0.125, size: 10, text: "Udyam: UDYAM-KR-03-0000000, Hosur Road, Bengaluru" },
      { x: 0.08, y: 0.18, size: 13, text: `Tax invoice ${number}`, bold: true },
      { x: 0.08, y: 0.22, size: 10, text: `Invoice date: ${date}` },
      { x: 0.08, y: 0.245, size: 10, text: "Buyer: Apex Motors Pvt Ltd, Pune" },
      { x: 0.08, y: 0.27, size: 10, text: "Payment terms: 30 days from acceptance" },
      { x: 0.1, y: 0.375, size: 10, text: "Description", bold: true },
      { x: 0.7, y: 0.375, size: 10, text: "Amount (Rs)", bold: true },
      { x: 0.1, y: 0.41, size: 10, text: "Fabricated chassis brackets" },
      { x: 0.7, y: 0.41, size: 10, text: amount },
      { x: 0.1, y: 0.47, size: 10, text: "Total", bold: true },
      { x: 0.7, y: 0.47, size: 10, text: amount, bold: true },
      ...(accepted
        ? [
            { x: 0.58, y: 0.79, size: 11, text: "Received and accepted", bold: true },
            { x: 0.58, y: 0.82, size: 10, text: "Apex Motors Pvt Ltd - Stores" },
            { x: 0.58, y: 0.85, size: 10, text: accepted },
          ]
        : []),
    ],
  };
}

export const invoicesLayout: SourceLayout = {
  documentId: "c-doc-invoices",
  fileName: "invoices_KF-2025-101_to_118.pdf",
  pages: [
    invoicePage("KF-2025-101", "02/04/2026", "1,80,000", 1),
    invoicePage("KF-2025-102", "10/04/2026", "2,05,000", 2),
    invoicePage("KF-2025-103", "21/04/2026", "1,60,000", 3),
    invoicePage("KF-2025-104", "02/05/2026", "2,40,000", 4, "05/05/2026"),
  ],
};

export const udyamLayout: SourceLayout = {
  documentId: "c-doc-udyam",
  fileName: "udyam_registration_certificate.pdf",
  pages: [
    {
      method: "pdf-text",
      confidence: 0.99,
      lines: [
        ...footer(1, 1),
        { x: 0.08, y: 0.09, size: 16, text: "Udyam Registration Certificate", bold: true },
        { x: 0.08, y: 0.13, size: 10, text: "Ministry of Micro, Small and Medium Enterprises" },
        { x: 0.08, y: 0.2, size: 10, text: "Udyam Registration Number: UDYAM-KR-03-0000000" },
        { x: 0.08, y: 0.225, size: 10, text: "Name of enterprise: Kaveri Fabricators" },
        { x: 0.08, y: 0.25, size: 10, text: "Type of enterprise: Micro" },
        { x: 0.08, y: 0.275, size: 10, text: "Major activity: Manufacturing" },
        { x: 0.08, y: 0.3, size: 10, text: "Date of Udyam Registration 14/03/2023" },
        { x: 0.08, y: 0.325, size: 10, text: "Date of incorporation: 09/01/2019" },
      ],
    },
  ],
};

export const remindersLayout: SourceLayout = {
  documentId: "c-doc-reminders",
  fileName: "payment_reminder_emails.pdf",
  pages: [
    {
      method: "pdf-text",
      confidence: 0.97,
      lines: [
        ...footer(1, 2),
        { x: 0.08, y: 0.09, size: 13, text: "Payment reminders", bold: true },
        { x: 0.08, y: 0.14, size: 10, text: "12 Jun 2026, to accounts@apexmotors.example" },
        {
          x: 0.08,
          y: 0.165,
          size: 10,
          text: "Invoices KF-2025-104, 107 are overdue. Please arrange payment.",
        },
        { x: 0.08, y: 0.22, size: 10, text: "18 Jul 2026, to accounts@apexmotors.example" },
        {
          x: 0.08,
          y: 0.245,
          size: 10,
          text: "Second reminder for invoices KF-2025-104, 107, and 111.",
        },
      ],
    },
    {
      method: "pdf-text",
      confidence: 0.97,
      lines: [
        ...footer(2, 2),
        { x: 0.08, y: 0.09, size: 10, text: "22 Aug 2026, to accounts@apexmotors.example" },
        {
          x: 0.08,
          y: 0.115,
          size: 10,
          text: "Third reminder: four invoices totalling Rs 8,42,000 remain unpaid.",
        },
        { x: 0.08, y: 0.18, size: 10, text: "23 Aug 2026, from accounts@apexmotors.example" },
        {
          x: 0.08,
          y: 0.205,
          size: 10,
          text: "We acknowledge the outstanding amount and will share a payment plan.",
        },
      ],
    },
  ],
};

export const sourceLayouts: SourceLayout[] = [
  noticeLayout,
  form26asLayout,
  clientNoteLayout,
  invoicesLayout,
  udyamLayout,
  remindersLayout,
];
