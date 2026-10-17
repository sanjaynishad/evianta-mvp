import { buyer, company, productBySku } from "../data/business.js";
import {
  LEDGER_START_DATE,
  STATEMENT_DATE,
  apexAccountEntries,
  apexOpeningInvoice,
  daysOverdue,
  dueDateOf,
  invoiceTotal,
  outstandingTotal,
  purchaseOrder,
  unpaidApexInvoices,
} from "../data/receivables.js";
import { SALES_PERIOD_LABEL, lineAmount, salesRegisterLines } from "../data/sales.js";
import { createDemoConnector, CSV_MIME_TYPE, textFile, type DemoItem } from "../demo.js";
import { formatLongDate, formatRupees, toCsv, type CsvCell } from "../format.js";

function partyLedgerCsv(): string {
  const entries = apexAccountEntries();
  let balance: number = apexOpeningInvoice.amount;
  const rows: CsvCell[][] = [
    [LEDGER_START_DATE, "Opening Balance", null, null, null, null, balance, null],
  ];

  for (const entry of entries) {
    if (entry.kind === "invoice") {
      balance += entry.amount;
      rows.push([
        entry.date,
        "Sales GST 18%",
        "Sales",
        entry.invoice.number,
        entry.amount,
        null,
        balance,
        `Supply against PO ${purchaseOrder.number}, due ${dueDateOf(entry.invoice)}`,
      ]);
    } else {
      balance -= entry.amount;
      rows.push([
        entry.date,
        "Konkan Mercantile Bank Ltd (Current A/c)",
        "Receipt",
        entry.payment.receiptVoucher,
        null,
        entry.amount,
        balance,
        `NEFT ${entry.payment.utr} against ${entry.payment.invoiceNumber}`,
      ]);
    }
  }

  rows.push([STATEMENT_DATE, "Closing Balance", null, null, null, null, balance, null]);

  return toCsv(
    ["Date", "Particulars", "Vch Type", "Vch No", "Debit", "Credit", "Balance", "Narration"],
    rows,
  );
}

function outstandingCsv(): string {
  const invoices = unpaidApexInvoices();
  const rows: CsvCell[][] = invoices.map((invoice) => [
    invoice.number,
    invoice.date,
    dueDateOf(invoice),
    purchaseOrder.number,
    invoiceTotal(invoice),
    invoiceTotal(invoice),
    daysOverdue(invoice),
  ]);
  const total = outstandingTotal(invoices);

  rows.push(["Total", null, null, null, total, total, null]);

  return toCsv(
    [
      "Invoice No",
      "Invoice Date",
      "Due Date",
      "PO Ref",
      "Invoice Amount",
      "Outstanding",
      "Days Overdue",
    ],
    rows,
  );
}

function salesRegisterCsv(): string {
  return toCsv(
    ["Date", "Voucher No", "Party", "Region", "Item", "Category", "Qty", "Rate", "Amount"],
    salesRegisterLines().map((line) => {
      const product = productBySku(line.sku);

      return [
        line.date,
        line.voucher,
        line.party,
        line.region,
        product.name,
        product.category,
        line.quantity,
        product.rate,
        lineAmount(line),
      ];
    }),
  );
}

const voucherCount = apexAccountEntries().length;
const salesLineCount = salesRegisterLines().length;
const unpaidCount = unpaidApexInvoices().length;

const items: Record<string, DemoItem> = {
  "party-ledger": {
    label: `Party ledger: ${buyer.name}`,
    detail: `FY 2026-27 to ${formatLongDate(STATEMENT_DATE)}, ${voucherCount} vouchers`,
    fileName: "tally-party-ledger-apex-retail-fy2026-27.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(partyLedgerCsv()),
  },
  "outstanding-receivables": {
    label: `Outstanding receivables: ${buyer.name}`,
    detail: `${unpaidCount} unpaid bills, ${formatRupees(outstandingTotal())} as on ${formatLongDate(STATEMENT_DATE)}`,
    fileName: "tally-outstanding-statement-apex-retail.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(outstandingCsv()),
  },
  "sales-register": {
    label: `Sales register: ${SALES_PERIOD_LABEL}`,
    detail: `${company.name}, ${salesLineCount} invoice lines across 4 regions`,
    fileName: "tally-sales-register-apr-sep-2026.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(salesRegisterCsv()),
  },
};

export const tallyConnector = createDemoConnector("tally", items);
