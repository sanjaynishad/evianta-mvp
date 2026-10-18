import { addDays, daysBetween } from "../format.js";
import { GST_RATE_PERCENT, productBySku, type Product } from "./business.js";

export const PAYMENT_TERMS_DAYS = 45;
export const STATEMENT_DATE = "2026-10-15";
export const LEDGER_START_DATE = "2026-04-01";

export const purchaseOrder = {
  number: "APX/PO/26-27/0418",
  date: "2026-04-10",
  acceptedOn: "2026-04-11",
} as const;

export interface InvoiceLine {
  sku: string;
  quantity: number;
}

export interface SalesInvoice {
  number: string;
  date: string;
  lines: readonly InvoiceLine[];
}

export interface PricedLine {
  product: Product;
  quantity: number;
  amount: number;
}

export interface InvoiceTotals {
  lines: PricedLine[];
  taxable: number;
  cgst: number;
  sgst: number;
  total: number;
}

export interface BuyerPayment {
  date: string;
  utr: string;
  receiptVoucher: string;
  invoiceNumber: string;
  amount: number;
}

export function priceLines(lines: readonly InvoiceLine[]): PricedLine[] {
  return lines.map((line) => {
    const product = productBySku(line.sku);

    return { product, quantity: line.quantity, amount: product.rate * line.quantity };
  });
}

export function totalsOf(lines: readonly InvoiceLine[]): InvoiceTotals {
  const priced = priceLines(lines);
  const taxable = priced.reduce((sum, line) => sum + line.amount, 0);
  const halfTax = Math.round((taxable * GST_RATE_PERCENT) / 200);

  return { lines: priced, taxable, cgst: halfTax, sgst: halfTax, total: taxable + 2 * halfTax };
}

/** Intra-state supplies from Pune to Mumbai, so GST is split into CGST and SGST. */
export const apexInvoices: readonly SalesInvoice[] = [
  {
    number: "SHI/26-27/014",
    date: "2026-04-18",
    lines: [
      { sku: "SHI-CNT-SET3", quantity: 400 },
      { sku: "SHI-BTL-1000", quantity: 400 },
    ],
  },
  {
    number: "SHI/26-27/031",
    date: "2026-05-09",
    lines: [
      { sku: "SHI-LBX-3C", quantity: 600 },
      { sku: "SHI-CNT-1000", quantity: 800 },
      { sku: "SHI-ORG-SPICE", quantity: 250 },
    ],
  },
  {
    number: "SHI/26-27/052",
    date: "2026-06-06",
    lines: [
      { sku: "SHI-LBX-INS", quantity: 400 },
      { sku: "SHI-BTL-1000", quantity: 400 },
      { sku: "SHI-ORG-TRAY", quantity: 400 },
    ],
  },
  {
    number: "SHI/26-27/067",
    date: "2026-06-27",
    lines: [
      { sku: "SHI-CNT-SET3", quantity: 350 },
      { sku: "SHI-BTL-750", quantity: 900 },
    ],
  },
  {
    number: "SHI/26-27/083",
    date: "2026-07-18",
    lines: [
      { sku: "SHI-LBX-3C", quantity: 500 },
      { sku: "SHI-ORG-SPICE", quantity: 450 },
      { sku: "SHI-CNT-1000", quantity: 600 },
    ],
  },
  {
    number: "SHI/26-27/098",
    date: "2026-08-08",
    lines: [
      { sku: "SHI-BTL-1000", quantity: 300 },
      { sku: "SHI-LBX-INS", quantity: 250 },
    ],
  },
];

/** Last year's invoice, unpaid on 1 April 2026 and settled within the agreed 45 days. */
export const apexOpeningInvoice = {
  number: "SHI/25-26/362",
  date: "2026-03-14",
  amount: 174_640,
} as const;

export const apexPayments: readonly BuyerPayment[] = [
  {
    date: "2026-04-27",
    utr: "N117261048527",
    receiptVoucher: "RCT/26-27/021",
    invoiceNumber: "SHI/25-26/362",
    amount: 174_640,
  },
  {
    date: "2026-06-01",
    utr: "N152261127304",
    receiptVoucher: "RCT/26-27/064",
    invoiceNumber: "SHI/26-27/014",
    amount: 212_400,
  },
  {
    date: "2026-07-14",
    utr: "N195261209811",
    receiptVoucher: "RCT/26-27/118",
    invoiceNumber: "SHI/26-27/031",
    amount: 247_800,
  },
];

export function dueDateOf(invoice: Pick<SalesInvoice, "date">): string {
  return addDays(invoice.date, PAYMENT_TERMS_DAYS);
}

export function invoiceTotal(invoice: SalesInvoice): number {
  return totalsOf(invoice.lines).total;
}

export function findApexInvoice(number: string): SalesInvoice {
  const invoice = apexInvoices.find((candidate) => candidate.number === number);

  if (!invoice) {
    throw new Error(`Unknown demo invoice "${number}".`);
  }

  return invoice;
}

export function isPaid(invoice: SalesInvoice): boolean {
  return apexPayments.some((payment) => payment.invoiceNumber === invoice.number);
}

export function unpaidApexInvoices(): SalesInvoice[] {
  return apexInvoices.filter((invoice) => !isPaid(invoice));
}

export function outstandingTotal(invoices: readonly SalesInvoice[] = unpaidApexInvoices()): number {
  return invoices.reduce((sum, invoice) => sum + invoiceTotal(invoice), 0);
}

export function daysOverdue(invoice: SalesInvoice, asOf = STATEMENT_DATE): number {
  return Math.max(0, daysBetween(dueDateOf(invoice), asOf));
}

/** Every line ordered under the purchase order, summed by product in order of first delivery. */
export function purchaseOrderLines(): InvoiceLine[] {
  const quantities = new Map<string, number>();

  for (const invoice of apexInvoices) {
    for (const line of invoice.lines) {
      quantities.set(line.sku, (quantities.get(line.sku) ?? 0) + line.quantity);
    }
  }

  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

export type AccountEntry =
  | { kind: "invoice"; date: string; invoice: SalesInvoice; amount: number }
  | { kind: "payment"; date: string; payment: BuyerPayment; amount: number };

/** Invoices and receipts on the buyer's account from 1 April 2026, in date order. */
export function apexAccountEntries(): AccountEntry[] {
  const entries: AccountEntry[] = [
    ...apexInvoices.map((invoice): AccountEntry => ({
      kind: "invoice",
      date: invoice.date,
      invoice,
      amount: invoiceTotal(invoice),
    })),
    ...apexPayments.map((payment): AccountEntry => ({
      kind: "payment",
      date: payment.date,
      payment,
      amount: payment.amount,
    })),
  ];

  return entries.sort((left, right) => left.date.localeCompare(right.date));
}
