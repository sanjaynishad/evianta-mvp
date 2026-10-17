import { GST_RATE_PERCENT, buyer, company } from "../data/business.js";
import {
  PAYMENT_TERMS_DAYS,
  dueDateOf,
  findApexInvoice,
  invoiceTotal,
  priceLines,
  purchaseOrder,
  purchaseOrderLines,
  totalsOf,
} from "../data/receivables.js";
import { createDemoConnector, TEXT_MIME_TYPE, textFile, type DemoItem } from "../demo.js";
import { composeEmailThread, type EmailMessage } from "../email.js";
import { formatDashedDate, formatIndianNumber, formatRupees } from "../format.js";

const salesSender = `${company.partner} <${company.salesEmail}>`;
const purchaseContact = `${buyer.purchaseContact} <${buyer.purchaseEmail}>`;

function purchaseOrderText(): string {
  const lines = priceLines(purchaseOrderLines());
  const totals = totalsOf(purchaseOrderLines());
  const messages: EmailMessage[] = [
    {
      from: purchaseContact,
      to: salesSender,
      cc: company.accountsEmail,
      date: purchaseOrder.date,
      time: "15:30",
      subject: `Purchase Order ${purchaseOrder.number} for kitchen storage and lunchware`,
      body: [
        "Dear Mr. Sharma,",
        "",
        "Please find our purchase order below. Kindly confirm acceptance by return email.",
        "",
        "PURCHASE ORDER",
        `PO No: ${purchaseOrder.number}`,
        `PO Date: ${formatDashedDate(purchaseOrder.date)}`,
        `Buyer: ${buyer.name}, ${buyer.addressLines.join(", ")}`,
        `Buyer GSTIN: ${buyer.gstin}`,
        `Supplier: ${company.name}, ${company.addressLines.join(", ")}`,
        `Supplier GSTIN: ${company.gstin}`,
        "",
        "Sr | Item | SKU | Qty | Rate (Rs.) | Amount (Rs.)",
        ...lines.map(
          (line, index) =>
            `${index + 1} | ${line.product.name} | ${line.product.sku} | ${formatIndianNumber(line.quantity)} | ${formatIndianNumber(line.product.rate)} | ${formatIndianNumber(line.amount)}`,
        ),
        "",
        `Taxable value: ${formatRupees(totals.taxable)}`,
        `GST at ${GST_RATE_PERCENT}% (CGST and SGST): ${formatRupees(totals.cgst + totals.sgst)}`,
        `Total order value: ${formatRupees(totals.total)}`,
        "",
        "Terms and conditions",
        `1. Delivery: in monthly lots from April to August 2026 against delivery schedules issued by our merchandising team, to ${buyer.warehouse}.`,
        "2. Each invoice must quote this PO number and accompany the delivery challan.",
        `3. Payment terms: ${PAYMENT_TERMS_DAYS} days from the date of invoice, by NEFT to the supplier's bank account.`,
        "4. Goods are accepted on receipt at our warehouse unless a shortage or defect is reported in writing within 7 days of delivery.",
        "5. Prices are fixed for the duration of this order.",
        "",
        "Regards,",
        buyer.purchaseContact,
        `Purchase Manager, ${buyer.name}`,
      ],
    },
    {
      from: salesSender,
      to: purchaseContact,
      cc: company.accountsEmail,
      date: purchaseOrder.acceptedOn,
      time: "09:50",
      subject: `RE: Purchase Order ${purchaseOrder.number} for kitchen storage and lunchware`,
      body: [
        "Dear Ms. Kulkarni,",
        "",
        `Thank you for the order. We accept purchase order ${purchaseOrder.number} on the terms stated, including payment ${PAYMENT_TERMS_DAYS} days from the date of invoice. The first lot will be dispatched next week.`,
        "",
        `Please note that we are a micro enterprise, Udyam Registration No ${company.udyamNumber}.`,
        "",
        "Regards,",
        company.partner,
        `Managing Partner, ${company.name}`,
      ],
    },
  ];

  return composeEmailThread(messages);
}

function buyerCorrespondenceText(): string {
  const invoice = findApexInvoice("SHI/26-27/052");
  const messages: EmailMessage[] = [
    {
      from: salesSender,
      to: purchaseContact,
      cc: `${buyer.storesContact} <${buyer.storesEmail}>`,
      date: "2026-06-08",
      time: "17:10",
      subject: `Dispatch of lot 3 against PO ${purchaseOrder.number}`,
      body: [
        "Dear Ms. Kulkarni,",
        "",
        `Lot 3 has been dispatched today against invoice ${invoice.number} dated ${formatDashedDate(invoice.date)} for ${formatRupees(invoiceTotal(invoice))}, with delivery challan DC/26-27/052 on vehicle MH14 KA 4821. It should reach the Bhiwandi warehouse on ${formatDashedDate("2026-06-09")}.`,
        "",
        "Regards,",
        company.partner,
        company.name,
      ],
    },
    {
      from: `${buyer.storesContact} <${buyer.storesEmail}>`,
      to: salesSender,
      cc: buyer.purchaseEmail,
      date: "2026-06-10",
      time: "12:25",
      subject: `RE: Dispatch of lot 3 against PO ${purchaseOrder.number}`,
      body: [
        "Dear Sir,",
        "",
        `The goods against invoice ${invoice.number} were received in full and in good condition at our Bhiwandi warehouse on ${formatDashedDate("2026-06-09")}, under GRN APX/GRN/26-27/1187. No shortage or damage was found.`,
        "",
        "Regards,",
        buyer.storesContact,
        `Warehouse, ${buyer.name}`,
      ],
    },
    {
      from: `${company.partner} <${company.accountsEmail}>`,
      to: purchaseContact,
      cc: company.salesEmail,
      date: "2026-07-30",
      time: "10:05",
      subject: `Payment status of invoice ${invoice.number}`,
      body: [
        "Dear Ms. Kulkarni,",
        "",
        `Invoice ${invoice.number} fell due on ${formatDashedDate(dueDateOf(invoice))} and remains unpaid. Please let us know if there is any issue with the goods or the invoice so that we can resolve it quickly.`,
        "",
        "Regards,",
        company.partner,
        company.name,
      ],
    },
    {
      from: purchaseContact,
      to: `${company.partner} <${company.accountsEmail}>`,
      cc: company.salesEmail,
      date: "2026-08-03",
      time: "14:40",
      subject: `RE: Payment status of invoice ${invoice.number}`,
      body: [
        "Dear Mr. Sharma,",
        "",
        `There is no issue with the goods or the invoice. Invoice ${invoice.number} was approved by the purchase team and passed to accounts payable for payment. I have asked ${buyer.payablesContact} to update you on the payment date.`,
        "",
        "Regards,",
        buyer.purchaseContact,
        `Purchase Manager, ${buyer.name}`,
      ],
    },
  ];

  return composeEmailThread(messages);
}

const items: Record<string, DemoItem> = {
  "buyer-correspondence": {
    label: `Buyer correspondence: ${buyer.name}`,
    detail: "4 emails on delivery, acceptance, and payment, Jun to Aug 2026",
    fileName: "buyer-correspondence-apex-retail.txt",
    mimeType: TEXT_MIME_TYPE,
    buildAsync: () => textFile(buyerCorrespondenceText()),
  },
  "purchase-order": {
    label: `Purchase order ${purchaseOrder.number}`,
    detail: `${buyer.name}, ${formatDashedDate(purchaseOrder.date)}, payment ${PAYMENT_TERMS_DAYS} days from invoice`,
    fileName: "purchase-order-apx-po-26-27-0418.txt",
    mimeType: TEXT_MIME_TYPE,
    buildAsync: () => textFile(purchaseOrderText()),
  },
};

export const outlookConnector = createDemoConnector("outlook", items);
