import { GST_RATE_PERCENT, buyer, company, productCategories, products } from "../data/business.js";
import {
  LEDGER_START_DATE,
  PAYMENT_TERMS_DAYS,
  STATEMENT_DATE,
  apexAccountEntries,
  apexInvoices,
  apexOpeningInvoice,
  dueDateOf,
  invoiceTotal,
  purchaseOrder,
  totalsOf,
  type SalesInvoice,
} from "../data/receivables.js";
import { distributorBudget, monthLabel } from "../data/sales.js";
import {
  createDemoConnector,
  CSV_MIME_TYPE,
  PDF_MIME_TYPE,
  textFile,
  type DemoItem,
} from "../demo.js";
import {
  formatDashedDate,
  formatIndianNumber,
  formatLongDate,
  formatRupees,
  formatSlashDate,
  rupeesInWords,
  toCsv,
  type CsvCell,
} from "../format.js";
import { createTextPdfAsync, pdfColumns, type PdfBlock, type PdfColumn } from "../pdf.js";

const itemColumns: PdfColumn[] = [
  { x: pdfColumns.pageLeft },
  { x: 76 },
  { x: 300 },
  { x: 390, align: "right" },
  { x: 460, align: "right" },
  { x: pdfColumns.pageRight, align: "right" },
];
const summaryColumns: PdfColumn[] = [{ x: 300 }, { x: pdfColumns.pageRight, align: "right" }];

function invoicePage(invoice: SalesInvoice): PdfBlock[] {
  const totals = totalsOf(invoice.lines);
  const halfRate = GST_RATE_PERCENT / 2;

  return [
    { kind: "text", text: company.name.toUpperCase(), size: 15, bold: true },
    ...company.addressLines.map((text): PdfBlock => ({ kind: "text", text })),
    { kind: "text", text: `GSTIN: ${company.gstin}    PAN: ${company.pan}` },
    {
      kind: "text",
      text: `Udyam Registration No: ${company.udyamNumber} (Micro enterprise, Manufacturing)`,
    },
    { kind: "space", height: 10 },
    { kind: "text", text: "TAX INVOICE", size: 13, bold: true },
    { kind: "rule" },
    {
      kind: "row",
      cells: [`Invoice No: ${invoice.number}`, `Invoice Date: ${formatDashedDate(invoice.date)}`],
      columns: [{ x: pdfColumns.pageLeft }, { x: 320 }],
    },
    {
      kind: "row",
      cells: [
        `PO Ref: ${purchaseOrder.number} dated ${formatDashedDate(purchaseOrder.date)}`,
        `Due Date: ${formatDashedDate(dueDateOf(invoice))}`,
      ],
      columns: [{ x: pdfColumns.pageLeft }, { x: 320 }],
    },
    { kind: "space", height: 6 },
    { kind: "text", text: "Bill to:", bold: true },
    { kind: "text", text: buyer.name },
    ...buyer.addressLines.map((text): PdfBlock => ({ kind: "text", text })),
    { kind: "text", text: `GSTIN: ${buyer.gstin}    Place of supply: Maharashtra (27)` },
    { kind: "text", text: `Ship to: ${buyer.warehouse}` },
    { kind: "space", height: 10 },
    {
      kind: "row",
      cells: ["Sr", "Description", "HSN", "Qty", "Rate (Rs.)", "Amount (Rs.)"],
      columns: itemColumns,
      bold: true,
    },
    { kind: "rule" },
    ...totals.lines.map((line, index): PdfBlock => ({
      kind: "row",
      cells: [
        String(index + 1),
        line.product.name,
        line.product.hsn,
        formatIndianNumber(line.quantity),
        formatIndianNumber(line.product.rate),
        formatIndianNumber(line.amount),
      ],
      columns: itemColumns,
    })),
    { kind: "rule" },
    {
      kind: "row",
      cells: ["Taxable value", formatIndianNumber(totals.taxable)],
      columns: summaryColumns,
    },
    {
      kind: "row",
      cells: [`CGST at ${halfRate}%`, formatIndianNumber(totals.cgst)],
      columns: summaryColumns,
    },
    {
      kind: "row",
      cells: [`SGST at ${halfRate}%`, formatIndianNumber(totals.sgst)],
      columns: summaryColumns,
    },
    {
      kind: "row",
      cells: ["Invoice total (Rs.)", formatIndianNumber(totals.total)],
      columns: summaryColumns,
      bold: true,
    },
    { kind: "space", height: 6 },
    { kind: "text", text: `Amount in words: ${rupeesInWords(totals.total)}` },
    { kind: "space", height: 10 },
    {
      kind: "text",
      text: `Payment terms: ${PAYMENT_TERMS_DAYS} days from the date of invoice.`,
      bold: true,
    },
    {
      kind: "text",
      text: "Interest under section 16 of the MSMED Act, 2006 is payable on amounts paid after the due date.",
    },
    { kind: "text", text: `Bank: ${company.bankLine}` },
    { kind: "space", height: 24 },
    { kind: "text", text: `For ${company.name}` },
    { kind: "space", height: 18 },
    { kind: "text", text: "Authorised Signatory" },
  ];
}

function invoicesPdfAsync(): Promise<Buffer> {
  return createTextPdfAsync({
    title: `Tax invoices to ${buyer.name}`,
    author: company.name,
    subject: `Invoices against ${purchaseOrder.number}`,
    createdOn: STATEMENT_DATE,
    pages: apexInvoices.map(invoicePage),
  });
}

function customerStatementCsv(): string {
  let balance: number = apexOpeningInvoice.amount;
  const rows: CsvCell[][] = [
    [
      LEDGER_START_DATE,
      "Opening Balance",
      `${apexOpeningInvoice.number} dated ${formatSlashDate(apexOpeningInvoice.date)}`,
      null,
      null,
      balance,
    ],
  ];

  for (const entry of apexAccountEntries()) {
    if (entry.kind === "invoice") {
      balance += entry.amount;
      rows.push([
        entry.date,
        "Invoice",
        `${entry.invoice.number}, due on ${formatSlashDate(dueDateOf(entry.invoice))}`,
        entry.amount,
        null,
        balance,
      ]);
    } else {
      balance -= entry.amount;
      rows.push([
        entry.date,
        "Payment Received",
        `NEFT ${entry.payment.utr}, for payment of ${entry.payment.invoiceNumber}`,
        null,
        entry.amount,
        balance,
      ]);
    }
  }

  rows.push([STATEMENT_DATE, "Balance Due", null, null, null, balance]);

  return toCsv(["Date", "Transactions", "Details", "Amount", "Payments", "Balance"], rows);
}

function itemsCsv(): string {
  return toCsv(
    ["Item Name", "SKU", "Category", "Unit", "Rate", "MRP", "HSN/SAC", "Tax", "Status"],
    products.map((product) => [
      product.name,
      product.sku,
      product.category,
      "pcs",
      product.rate,
      product.mrp,
      product.hsn,
      `GST${GST_RATE_PERCENT}`,
      "Active",
    ]),
  );
}

function budgetCsv(): string {
  return toCsv(
    ["Month", "Region", "Budgeted Sales (Rs)"],
    distributorBudget.map((figure) => [monthLabel(figure.month), figure.region, figure.amount]),
  );
}

const invoicedTotal = apexInvoices.reduce((sum, invoice) => sum + invoiceTotal(invoice), 0);
const closingBalance = apexAccountEntries().reduce<number>(
  (balance, entry) => balance + (entry.kind === "invoice" ? entry.amount : -entry.amount),
  apexOpeningInvoice.amount,
);

const items: Record<string, DemoItem> = {
  invoices: {
    label: `Invoices: ${buyer.name}`,
    detail: `${apexInvoices.length} tax invoices, Apr to Aug 2026, ${formatRupees(invoicedTotal)}`,
    fileName: "zoho-invoices-apex-retail-apr-aug-2026.pdf",
    mimeType: PDF_MIME_TYPE,
    buildAsync: invoicesPdfAsync,
  },
  "customer-statement": {
    label: `Customer statement: ${buyer.name}`,
    detail: `1 Apr to ${formatLongDate(STATEMENT_DATE)}, balance due ${formatRupees(closingBalance)}`,
    fileName: "zoho-customer-statement-apex-retail.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(customerStatementCsv()),
  },
  items: {
    label: "Items: product list",
    detail: `${products.length} products in ${productCategories().length} categories`,
    fileName: "zoho-items-product-list.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(itemsCsv()),
  },
  budget: {
    label: "Budget: monthly distributor sales by region",
    detail: "Apr to Sep 2026, 4 regions, before GST",
    fileName: "zoho-budget-fy2026-27-by-region.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(budgetCsv()),
  },
};

export const zohoBooksConnector = createDemoConnector("zoho-books", items);
