import { buyer, company } from "../data/business.js";
import {
  PAYMENT_TERMS_DAYS,
  apexPayments,
  dueDateOf,
  findApexInvoice,
  invoiceTotal,
  outstandingTotal,
  purchaseOrder,
  unpaidApexInvoices,
  type SalesInvoice,
} from "../data/receivables.js";
import {
  ASSESSMENT_YEAR,
  assessee,
  deductors,
  form26AsEntries,
  intimation,
  returnFiling,
  summarizeByDeductor,
  tdsEntries,
  totalTds,
} from "../data/tax.js";
import { createDemoConnector, TEXT_MIME_TYPE, textFile, type DemoItem } from "../demo.js";
import { composeEmailThread, type EmailMessage } from "../email.js";
import { daysBetween, formatDashedDate, formatIndianNumber, formatRupees } from "../format.js";

const accountsSender = `${company.partner} <${company.accountsEmail}>`;
const payablesRecipient = `${buyer.payablesContact} <${buyer.payablesEmail}>`;
const payablesGreeting = "Dear Mr. Shah,";
const signature = [
  "Regards,",
  company.partner,
  `Managing Partner, ${company.name}`,
  `Udyam Registration No: ${company.udyamNumber} (Micro)`,
];

function invoiceLine(invoice: SalesInvoice): string {
  return `- ${invoice.number} dated ${formatDashedDate(invoice.date)}, ${formatRupees(invoiceTotal(invoice))}, due on ${formatDashedDate(dueDateOf(invoice))}`;
}

function paymentRemindersText(): string {
  const first = findApexInvoice("SHI/26-27/052");
  const second = findApexInvoice("SHI/26-27/067");
  const unpaid = unpaidApexInvoices();
  const thirdReminderDate = "2026-09-25";
  const latePayment = apexPayments.find((payment) => payment.invoiceNumber === "SHI/26-27/031");
  const latePaidInvoice = findApexInvoice("SHI/26-27/031");

  if (!latePayment) {
    throw new Error("The demo payments are missing SHI/26-27/031.");
  }

  const messages: EmailMessage[] = [
    {
      from: accountsSender,
      to: payablesRecipient,
      cc: buyer.purchaseEmail,
      date: "2026-07-24",
      time: "10:42",
      subject: `Payment reminder: invoice ${first.number} overdue`,
      body: [
        payablesGreeting,
        "",
        `This is a reminder that our invoice ${first.number} dated ${formatDashedDate(first.date)} for ${formatRupees(invoiceTotal(first))}, raised against your purchase order ${purchaseOrder.number}, fell due on ${formatDashedDate(dueDateOf(first))} and is still unpaid.`,
        "",
        "Please arrange the payment at the earliest and share the remittance details.",
        "",
        ...signature,
      ],
    },
    {
      from: accountsSender,
      to: payablesRecipient,
      cc: buyer.purchaseEmail,
      date: "2026-08-18",
      time: "11:05",
      subject: `Second reminder: invoices ${first.number} and ${second.number} overdue`,
      body: [
        payablesGreeting,
        "",
        "We have not received payment for the following invoices:",
        invoiceLine(first),
        invoiceLine(second),
        `Total overdue: ${formatRupees(invoiceTotal(first) + invoiceTotal(second))}`,
        "",
        `Under the purchase order, each invoice is payable ${PAYMENT_TERMS_DAYS} days from the date of invoice. We are a micro enterprise registered under the MSMED Act, 2006, and delayed payment attracts interest under section 16 of the Act.`,
        "",
        "Please release the payment this week.",
        "",
        ...signature,
      ],
    },
    {
      from: payablesRecipient,
      to: accountsSender,
      cc: buyer.purchaseEmail,
      date: "2026-09-08",
      time: "16:20",
      subject: `RE: Second reminder: invoices ${first.number} and ${second.number} overdue`,
      body: [
        "Dear Mr. Sharma,",
        "",
        `We acknowledge your reminders. Invoices ${first.number} and ${second.number} have been approved by our purchase team and there is no dispute on quantity or quality. Their release is pending because of internal fund constraints, and we expect to clear them in our next payment run.`,
        "",
        "Regards,",
        buyer.payablesContact,
        `Accounts Payable, ${buyer.name}`,
      ],
    },
    {
      from: accountsSender,
      to: payablesRecipient,
      cc: `${buyer.purchaseEmail}, ${company.salesEmail}`,
      date: thirdReminderDate,
      time: "10:15",
      subject: `Third reminder: ${formatRupees(outstandingTotal(unpaid))} overdue on ${unpaid.length} invoices`,
      body: [
        payablesGreeting,
        "",
        `Despite your email of ${formatDashedDate("2026-09-08")}, no payment has been received. The following invoices are unpaid:`,
        ...unpaid.map(invoiceLine),
        `Total outstanding: ${formatRupees(outstandingTotal(unpaid))}`,
        "",
        `We also note that invoice ${latePaidInvoice.number} was paid on ${formatDashedDate(latePayment.date)}, ${daysBetween(dueDateOf(latePaidInvoice), latePayment.date)} days after its due date.`,
        "",
        "Under sections 15 and 16 of the MSMED Act, 2006, the buyer is liable to pay compound interest with monthly rests at three times the bank rate notified by the Reserve Bank of India on amounts paid after the due date.",
        "",
        `Please clear the outstanding amount by ${formatDashedDate("2026-10-10")}. Otherwise we will refer the matter to the Micro and Small Enterprises Facilitation Council through the MSME Samadhaan portal.`,
        "",
        ...signature,
      ],
    },
  ];

  return composeEmailThread(messages);
}

function taxIntimationText(): string {
  const claimed = summarizeByDeductor(tdsEntries);
  const reported = summarizeByDeductor(form26AsEntries());
  const claimedTotal = totalTds(tdsEntries);
  const reportedTotal = totalTds(form26AsEntries());
  const difference = claimedTotal - reportedTotal;
  const mismatches = claimed
    .map((summary) => {
      const asPer26As =
        reported.find((entry) => entry.deductor.tan === summary.deductor.tan)?.tds ?? 0;

      return { ...summary, asPer26As, difference: summary.tds - asPer26As };
    })
    .filter((entry) => entry.difference !== 0);

  const message: EmailMessage = {
    from: "Centralized Processing Centre <intimations@cpc-demo.example>",
    to: company.accountsEmail,
    date: intimation.date,
    time: "11:15",
    subject: `Communication of proposed adjustment under section 143(1)(a) for AY ${ASSESSMENT_YEAR}, PAN ${assessee.pan}`,
    body: [
      "Income Tax Department",
      "Centralized Processing Centre, Bengaluru",
      "",
      "Communication of proposed adjustment under section 143(1)(a) of the Income-tax Act, 1961",
      "",
      `Name of assessee: ${assessee.name}`,
      `PAN: ${assessee.pan}`,
      `Status: ${assessee.status}`,
      `Assessment Year: ${ASSESSMENT_YEAR}`,
      `Acknowledgement number of return: ${returnFiling.acknowledgementNumber}`,
      `Date of filing of return: ${formatDashedDate(returnFiling.filedOn)}`,
      `Communication reference number: ${intimation.referenceNumber}`,
      `Date of communication: ${formatDashedDate(intimation.date)}`,
      `Response due by: ${formatDashedDate(intimation.responseDueBy)}`,
      "",
      "Dear Taxpayer,",
      "",
      `While processing the return of income for Assessment Year ${ASSESSMENT_YEAR} under section 143(1), the credit for tax deducted at source (TDS) claimed in the return was found to be higher than the TDS reported by the deductors in Form 26AS. An adjustment is therefore proposed under section 143(1)(a) of the Income-tax Act, 1961.`,
      "",
      "Summary of the proposed adjustment",
      `TDS claimed in the return: ${formatRupees(claimedTotal)}`,
      `TDS as per Form 26AS: ${formatRupees(reportedTotal)}`,
      `TDS credit proposed to be disallowed: ${formatRupees(difference)}`,
      "",
      "Deductor-wise details",
      "TAN | Name of deductor | Section | TDS claimed (Rs.) | TDS as per Form 26AS (Rs.) | Difference (Rs.)",
      ...mismatches.map(
        (entry) =>
          `${entry.deductor.tan} | ${entry.deductor.name} | ${entry.deductor.section} | ${formatIndianNumber(entry.tds)} | ${formatIndianNumber(entry.asPer26As)} | ${formatIndianNumber(entry.difference)}`,
      ),
      "",
      `If the adjustment is made, tax of ${formatRupees(difference)} and interest under section 234C of ${formatRupees(intimation.interestUnder234C)} will become payable, a demand of ${formatRupees(difference + intimation.interestUnder234C)}.`,
      "",
      "You may agree or disagree with the proposed adjustment. Submit your response on the e-filing portal under Pending Actions, e-Proceedings, within 30 days of the date of this communication. If no response is received, the return will be processed with the adjustment.",
      "",
      `If you disagree, furnish the TDS certificate in Form 16A from ${deductors.kiran.name}, a reconciliation of the TDS claimed with Form 26AS, and details of the corresponding income offered in the return.`,
      "",
      "This is a system-generated communication. Please do not reply to this email.",
    ],
  };

  return composeEmailThread([message]);
}

const unpaidTotal = outstandingTotal();

const items: Record<string, DemoItem> = {
  "payment-reminders": {
    label: `Payment reminders: ${buyer.name}`,
    detail: `4 emails, 24 Jul to 25 Sep 2026, ${formatRupees(unpaidTotal)} outstanding`,
    fileName: "payment-reminders-apex-retail.txt",
    mimeType: TEXT_MIME_TYPE,
    buildAsync: () => textFile(paymentRemindersText()),
  },
  "tax-intimation": {
    label: `Income-tax intimation: AY ${ASSESSMENT_YEAR}`,
    detail: `CPC proposal under section 143(1)(a), ${formatDashedDate(intimation.date)}, TDS mismatch`,
    fileName: "income-tax-intimation-143-1a-ay2025-26.txt",
    mimeType: TEXT_MIME_TYPE,
    buildAsync: () => textFile(taxIntimationText()),
  },
};

export const gmailConnector = createDemoConnector("gmail", items);
