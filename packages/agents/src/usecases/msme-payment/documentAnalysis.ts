import type { ConfidenceLevel } from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent, type AgentResult } from "../../agent.js";
import {
  SPECIALIST_DEFINITIONS,
  specialistInputSchema,
  type SpecialistInput,
} from "../../agents/specialist.js";
import {
  agentFindingSchema,
  specialistOutputSchema,
  type AgentFindingInput,
  type EvidenceReference,
  type OpenQuestionDraft,
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskHandler,
  type TaskOutput,
  type TaskSectionDraft,
} from "../../handlers.js";
import { truncate } from "../../text.js";
import { documentEventDateKey, recordRowEvidence, type DocumentEventKind } from "./chronology.js";
import {
  formatInrAmount,
  markdownTableOf,
  MSME_FIGURE_KEYS,
  msmePaymentPackSpec,
  statedInvoiceAmountFigureKey,
} from "./constants.js";
import {
  createPreparedHandler,
  loadPaymentCaseDocumentsAsync,
  paymentPagesToVerify,
  resolveAgentFor,
  withoutRecordTables,
  type PaymentReviewPage,
} from "./context.js";
import { toIsoDate } from "./dates.js";
import {
  normalizeInvoiceNumber,
  readPaymentRecords,
  recordTableKeys,
  recordLocationLabel,
  type PaymentRecordSet,
} from "./records.js";
import { creditTermsInDocuments, type CreditTermsSource } from "./terms.js";

export const MAX_RECORD_ROW_EVIDENCE = 12;

export const msmeDocumentSourceSchema = z.object({
  documentId: z.string(),
  page: z.number().int().positive().optional(),
  quote: z.string().optional(),
});

export type MsmeDocumentSource = z.infer<typeof msmeDocumentSourceSchema>;

export const msmeDocumentKindSchema = z.enum([
  "purchase-order",
  "agreement",
  "invoice",
  "delivery-record",
  "correspondence",
  "invoice-register",
  "payment-record",
  "other",
]);

export type MsmeDocumentKind = z.infer<typeof msmeDocumentKindSchema>;

export const documentAnalysisOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  documents: z
    .array(
      z.object({
        documentId: z.string(),
        kind: msmeDocumentKindSchema,
        title: z.string().optional(),
        reference: z.string().optional(),
        date: z.string().optional(),
        parties: z.array(z.string()).default([]),
        summary: z.string().optional(),
        source: msmeDocumentSourceSchema.optional(),
      }),
    )
    .default([]),
  paymentTerms: z
    .array(
      z.object({
        creditDays: z.number().int().positive(),
        description: z.string(),
        source: msmeDocumentSourceSchema.optional(),
      }),
    )
    .default([]),
  invoices: z
    .array(
      z.object({
        invoiceNumber: z.string().min(1),
        date: z.string().optional(),
        amount: z.number().optional(),
        dueDate: z.string().optional(),
        source: msmeDocumentSourceSchema.optional(),
      }),
    )
    .default([]),
  deliveries: z
    .array(
      z.object({
        reference: z.string().optional(),
        date: z.string(),
        invoiceRefs: z.array(z.string()).default([]),
        description: z.string().optional(),
        source: msmeDocumentSourceSchema.optional(),
      }),
    )
    .default([]),
  correspondence: z
    .array(
      z.object({
        date: z.string(),
        sender: z.string(),
        recipient: z.string().optional(),
        summary: z.string().min(1),
        invoiceRefs: z.array(z.string()).default([]),
        source: msmeDocumentSourceSchema.optional(),
      }),
    )
    .default([]),
});

export type DocumentAnalysisOutput = z.infer<typeof documentAnalysisOutputSchema>;

export type DocumentAnalysisAgent = Agent<SpecialistInput, DocumentAnalysisOutput>;

export const DOCUMENT_ANALYSIS_SYSTEM_PROMPT = [
  "You organize the documents of an MSME supplier's overdue-payment case for the business owner or adviser to review.",
  "Classify every document in documents (purchase order, agreement, invoice, delivery record, correspondence, or other) in documents[], with its reference number, date, parties, and a one-line summary.",
  "Extract key fields: payment terms and credit days from purchase orders and agreements (paymentTerms); invoice number, date, amount, and due date from any invoice copy or document that states them (invoices); delivery date and the invoice each delivery relates to (deliveries); and date, sender, recipient, a neutral summary, and the invoices mentioned for each letter or email (correspondence).",
  "context.recordTables lists the invoice register and payment records, which are read deterministically; do not re-extract their rows.",
  "Every item needs a source with the documentId, the 1-based page, and a short verbatim quote. Never invent a number, date, or amount; leave it out if the text does not state it. Dates are ISO yyyy-mm-dd and amounts are plain numbers in rupees.",
  "context.lowConfidencePages lists pages read by OCR or handwriting recognition with low confidence; flag anything taken from them in openQuestions for verification against the original.",
  "Do not judge who is right or make any legal determination.",
].join("\n");

export function createDocumentAnalysisAgent(): DocumentAnalysisAgent {
  const { profile } = SPECIALIST_DEFINITIONS["document-analysis"];

  return defineAgent<SpecialistInput, DocumentAnalysisOutput>({
    role: "document-analysis",
    modelTier: profile.modelTier,
    systemPrompt: DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: documentAnalysisOutputSchema,
    grounding: false,
    maxOutputTokens: 4096,
    profile,
  });
}

interface DocumentAnalysisPrepared {
  records: PaymentRecordSet;
  recordTables: Set<string>;
  lowConfidencePages: PaymentReviewPage[];
  termsInText: CreditTermsSource[];
}

const KIND_LABELS: Readonly<Record<MsmeDocumentKind, string>> = {
  "purchase-order": "Purchase order",
  agreement: "Agreement",
  invoice: "Invoice",
  "delivery-record": "Delivery record",
  correspondence: "Correspondence",
  "invoice-register": "Invoice register",
  "payment-record": "Payment record",
  other: "Other",
};

function sourceEvidence(
  source: MsmeDocumentSource | undefined,
  description: string,
): EvidenceReference[] {
  if (!source) {
    return [];
  }

  return [
    {
      documentId: source.documentId,
      description,
      ...(source.page !== undefined ? { page: source.page } : {}),
      ...(source.quote?.trim() ? { textQuote: source.quote.trim() } : {}),
    },
  ];
}

function confidenceOf(
  source: MsmeDocumentSource | undefined,
  pages: readonly PaymentReviewPage[],
): ConfidenceLevel {
  if (!source) {
    return "low";
  }

  return pages.some((page) => page.documentId === source.documentId && page.page === source.page)
    ? "low"
    : "high";
}

function lowConfidenceQuestion(
  source: MsmeDocumentSource | undefined,
  pages: readonly PaymentReviewPage[],
  what: string,
): OpenQuestionDraft[] {
  const page = pages.find(
    (item) => item.documentId === source?.documentId && item.page === source?.page,
  );

  return page
    ? [
        {
          text: `${what} comes from ${page.documentName} page ${page.page}, read by ${page.method === "handwriting" ? "handwriting recognition" : "OCR"} at ${Math.round(page.confidence * 100)}% confidence. Verify it against the original.`,
          severity: "high",
        },
      ]
    : [];
}

function eventKindFor(kind: MsmeDocumentKind): DocumentEventKind | undefined {
  switch (kind) {
    case "purchase-order":
    case "agreement":
      return kind;
    case "invoice":
      return "invoice-copy";
    case "delivery-record":
      return "delivery";
    case "correspondence":
      return "correspondence";
    default:
      return undefined;
  }
}

export function documentFindings(
  output: DocumentAnalysisOutput,
  pages: readonly PaymentReviewPage[],
): AgentFindingInput[] {
  const findings: AgentFindingInput[] = [];
  const structuredEventDocuments = new Set([
    ...output.invoices.flatMap((invoice) => (invoice.source ? [invoice.source.documentId] : [])),
    ...output.deliveries.flatMap((delivery) =>
      delivery.source ? [delivery.source.documentId] : [],
    ),
    ...output.correspondence.flatMap((item) => (item.source ? [item.source.documentId] : [])),
  ]);

  output.documents.forEach((document, index) => {
    const label = KIND_LABELS[document.kind];
    const title = [label, document.reference].filter(Boolean).join(" ");
    const date = toIsoDate(document.date);
    const eventKind = eventKindFor(document.kind);
    const eventLabel =
      document.kind === "agreement"
        ? `${title} entered into`
        : document.kind === "purchase-order"
          ? `${title} issued`
          : `${title} dated`;

    findings.push({
      summary: `${title}${date ? ` dated ${date}` : ""}${document.summary ? `: ${truncate(document.summary, 160)}` : ""}`,
      ...(document.parties.length > 0 ? { detail: `Parties: ${document.parties.join(", ")}` } : {}),
      severity: "info",
      confidence: confidenceOf(document.source, pages),
      evidence: sourceEvidence(document.source ?? { documentId: document.documentId }, title),
      ...(date && eventKind && !structuredEventDocuments.has(document.documentId)
        ? {
            dates: [
              {
                key: documentEventDateKey(eventKind, [], document.reference ?? `${index + 1}`),
                label: eventLabel,
                date,
              },
            ],
          }
        : {}),
    });
  });

  for (const terms of output.paymentTerms) {
    findings.push({
      summary: `Agreed credit period: ${terms.creditDays} days`,
      detail: terms.description,
      severity: "medium",
      confidence: confidenceOf(terms.source, pages),
      evidence: sourceEvidence(terms.source, `Payment terms of ${terms.creditDays} days`),
      openQuestions: lowConfidenceQuestion(terms.source, pages, "The credit period"),
      figures: [
        {
          key: MSME_FIGURE_KEYS.agreedCreditDays,
          label: "Agreed credit period",
          value: terms.creditDays,
          unit: "days",
        },
      ],
    });
  }

  output.invoices.forEach((invoice, index) => {
    const date = toIsoDate(invoice.date);
    const where = invoice.source?.page !== undefined ? ` (p.${invoice.source.page})` : "";
    const facts = [
      invoice.amount !== undefined ? formatInrAmount(invoice.amount) : undefined,
      date ? `dated ${date}` : undefined,
      invoice.dueDate ? `due ${toIsoDate(invoice.dueDate) ?? invoice.dueDate}` : undefined,
    ].filter(Boolean);

    findings.push({
      summary: `Invoice ${invoice.invoiceNumber} stated in a document${facts.length > 0 ? `: ${facts.join(", ")}` : ""}${where}`,
      severity: "info",
      confidence: confidenceOf(invoice.source, pages),
      evidence: sourceEvidence(invoice.source, `Invoice ${invoice.invoiceNumber}`),
      openQuestions: lowConfidenceQuestion(
        invoice.source,
        pages,
        `The amount or date of ${invoice.invoiceNumber}`,
      ),
      ...(invoice.amount !== undefined
        ? {
            figures: [
              {
                key: statedInvoiceAmountFigureKey(
                  normalizeInvoiceNumber(invoice.invoiceNumber),
                  index,
                ),
                label: `${invoice.invoiceNumber} amount stated in a document`,
                value: invoice.amount,
                unit: "INR",
              },
            ],
          }
        : {}),
      ...(date
        ? {
            dates: [
              {
                key: documentEventDateKey(
                  "invoice-copy",
                  [invoice.invoiceNumber],
                  `${invoice.source?.documentId ?? "doc"}-${index + 1}`,
                ),
                label: `Invoice ${invoice.invoiceNumber} copy dated`,
                date,
              },
            ],
          }
        : {}),
    });
  });

  output.deliveries.forEach((delivery, index) => {
    const date = toIsoDate(delivery.date);
    const name = delivery.reference ? `Delivery ${delivery.reference}` : "Delivery";
    const forInvoices =
      delivery.invoiceRefs.length > 0 ? ` for ${delivery.invoiceRefs.join(", ")}` : "";

    findings.push({
      summary: `${name}${date ? ` on ${date}` : ""}${forInvoices}`,
      ...(delivery.description ? { detail: delivery.description } : {}),
      severity: "info",
      confidence: confidenceOf(delivery.source, pages),
      evidence: sourceEvidence(delivery.source, `${name}${forInvoices}`),
      ...(date
        ? {
            dates: [
              {
                key: documentEventDateKey(
                  "delivery",
                  delivery.invoiceRefs,
                  delivery.reference ?? `${index + 1}`,
                ),
                label: `Goods delivered${delivery.reference ? ` under ${delivery.reference}` : ""}${forInvoices}`,
                date,
              },
            ],
          }
        : {}),
    });
  });

  output.correspondence.forEach((item, index) => {
    const date = toIsoDate(item.date);
    const parties = item.recipient ? `${item.sender} to ${item.recipient}` : item.sender;
    const label = `Correspondence from ${parties}: ${truncate(item.summary, 160)}`;

    findings.push({
      summary: `${date ?? item.date} ${label}`,
      severity: "info",
      confidence: confidenceOf(item.source, pages),
      evidence: sourceEvidence(item.source, `Correspondence from ${item.sender}`),
      ...(date
        ? {
            dates: [
              {
                key: documentEventDateKey("correspondence", item.invoiceRefs, `${index + 1}`),
                label,
                date,
              },
            ],
          }
        : {}),
    });
  });

  return findings;
}

export function recordFindings(records: PaymentRecordSet): AgentFindingInput[] {
  const findings: AgentFindingInput[] = [];

  if (records.invoices.length > 0) {
    findings.push({
      summary: `Invoice register: ${records.invoices.length} invoice(s) read from ${[...new Set(records.invoices.map((invoice) => invoice.documentName))].join(", ")}`,
      detail: records.invoices
        .map(
          (invoice) =>
            `${invoice.invoiceNumber}: ${invoice.invoiceDate ?? "no date"}, ${formatInrAmount(invoice.amount ?? 0)}${invoice.dueDate ? `, due ${invoice.dueDate}` : ""}${invoice.poRef ? `, ${invoice.poRef}` : ""} (${recordLocationLabel(invoice)})`,
        )
        .join("\n"),
      severity: "info",
      confidence: "high",
      evidence: records.invoices
        .slice(0, MAX_RECORD_ROW_EVIDENCE)
        .map((invoice) => recordRowEvidence(invoice, `${invoice.invoiceNumber} invoice row`)),
    });
  }

  if (records.payments.length > 0) {
    findings.push({
      summary: `Payment records: ${records.payments.length} payment(s) read from ${[...new Set(records.payments.map((payment) => payment.documentName))].join(", ")}`,
      detail: records.payments
        .map(
          (payment) =>
            `${payment.label}: ${payment.date ?? "no date"}, ${formatInrAmount(payment.amount ?? 0)}${payment.invoiceRefs.length > 0 ? ` against ${payment.invoiceRefs.join(", ")}` : ", no invoice reference"} (${recordLocationLabel(payment)})`,
        )
        .join("\n"),
      severity: "info",
      confidence: "high",
      evidence: records.payments
        .slice(0, MAX_RECORD_ROW_EVIDENCE)
        .map((payment) => recordRowEvidence(payment, `Payment ${payment.label} row`)),
    });
  }

  if (records.unreadable.length > 0) {
    findings.push({
      summary: `${records.unreadable.length} record row(s) could not be read and were left out of the totals`,
      detail: records.unreadable
        .map((row) => `${recordLocationLabel(row)}: ${row.reason}`)
        .join("\n"),
      severity: "high",
      confidence: "high",
      evidence: records.unreadable.map((row) => recordRowEvidence(row, row.reason)),
      openQuestions: records.unreadable.map((row) => ({
        text: `${recordLocationLabel(row)}: ${row.reason}. Correct the source so it can be included.`,
        severity: "high" as const,
      })),
    });
  }

  return findings;
}

export function lowConfidencePagesFinding(
  pages: readonly PaymentReviewPage[],
): AgentFindingInput | undefined {
  if (pages.length === 0) {
    return undefined;
  }

  return {
    summary: `${pages.length} page(s) were transcribed with low confidence and need verification`,
    detail: pages
      .map(
        (page) =>
          `${page.documentName} p.${page.page}: ${page.method} at ${Math.round(page.confidence * 100)}% confidence`,
      )
      .join("\n"),
    severity: "medium",
    confidence: "low",
    evidence: pages.map((page) => ({
      documentId: page.documentId,
      page: page.page,
      description: `Low-confidence ${page.method} transcription`,
    })),
    openQuestions: pages.map((page) => ({
      text: `${page.documentName} page ${page.page} was read by ${page.method === "handwriting" ? "handwriting recognition" : "OCR"} at ${Math.round(page.confidence * 100)}% confidence. Verify any amount, date, or reference taken from it against the original.`,
      severity: "high" as const,
    })),
  };
}

function termsQuestions(
  output: DocumentAnalysisOutput,
  termsInText: readonly CreditTermsSource[],
): OpenQuestionDraft[] {
  const stated = new Set([
    ...output.paymentTerms.map((terms) => terms.creditDays),
    ...termsInText.map((terms) => terms.creditDays),
  ]);

  if (stated.size > 1) {
    return [
      {
        text: `The documents state different credit periods (${[...stated].join(" and ")} days). Confirm which one was agreed.`,
        severity: "high",
      },
    ];
  }

  if (stated.size === 0) {
    return [
      {
        text: "No credit period was found in the purchase orders or agreements. Confirm the agreed payment terms.",
        severity: "high",
      },
    ];
  }

  return [];
}

function documentRegisterMarkdown(
  output: DocumentAnalysisOutput,
  records: PaymentRecordSet,
  pages: readonly PaymentReviewPage[],
  documentNames: ReadonlyMap<string, string>,
): string {
  const rows = output.documents.map((document) => [
    documentNames.get(document.documentId) ?? document.documentId,
    KIND_LABELS[document.kind],
    document.reference ?? "-",
    toIsoDate(document.date) ?? document.date ?? "-",
    document.summary ?? document.title ?? "-",
  ]);

  for (const table of records.tables) {
    if (!output.documents.some((document) => document.documentId === table.documentId)) {
      rows.push([
        table.documentName,
        table.kind === "invoices" ? KIND_LABELS["invoice-register"] : KIND_LABELS["payment-record"],
        "-",
        "-",
        `${table.rowCount} row(s) read`,
      ]);
    }
  }

  const parts = [markdownTableOf(["Document", "Type", "Reference", "Date", "Summary"], rows)];

  if (pages.length > 0) {
    parts.push(
      "",
      "**Transcription to verify**",
      ...pages.map(
        (page) =>
          `- ${page.documentName} p.${page.page}: ${page.method}, ${Math.round(page.confidence * 100)}% confidence`,
      ),
    );
  }

  return parts.join("\n");
}

export function documentAnalysisTaskOutput(
  result: AgentResult<DocumentAnalysisOutput>,
  prepared: DocumentAnalysisPrepared,
  documentNames: ReadonlyMap<string, string>,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);
  const { output } = result;
  const findings = [
    ...recordFindings(prepared.records),
    ...documentFindings(output, prepared.lowConfidencePages),
    ...base.findings,
  ];
  const lowConfidence = lowConfidencePagesFinding(prepared.lowConfidencePages);

  if (lowConfidence) {
    findings.push(lowConfidence);
  }

  const sections: TaskSectionDraft[] = [
    {
      title: "Document register",
      kind: "table",
      content: documentRegisterMarkdown(
        output,
        prepared.records,
        prepared.lowConfidencePages,
        documentNames,
      ),
      findingIndexes: findings.map((_finding, index) => index),
    },
  ];

  return {
    ...base,
    findings,
    openQuestions: [...termsQuestions(output, prepared.termsInText), ...(base.openQuestions ?? [])],
    sections,
    deliverables: [msmePaymentPackSpec()],
  };
}

export interface DocumentAnalysisHandlerOptions {
  agent?: DocumentAnalysisAgent;
}

/** Classifies documents and extracts key fields with page references; invoice and payment rows are read deterministically. */
export function createDocumentAnalysisTaskHandler(
  options: DocumentAnalysisHandlerOptions = {},
): TaskHandler {
  return createPreparedHandler<DocumentAnalysisPrepared, SpecialistInput, DocumentAnalysisOutput>(
    "document-analysis",
    (ctx) => resolveAgentFor(ctx, "document-analysis", options.agent, createDocumentAnalysisAgent),
    {
      async prepareAsync(ctx) {
        const documents = await loadPaymentCaseDocumentsAsync(ctx);
        const records = readPaymentRecords(documents);

        return {
          records,
          recordTables: recordTableKeys(records),
          lowConfidencePages: paymentPagesToVerify(documents),
          termsInText: creditTermsInDocuments(documents),
        };
      },
      buildInput(ctx, prepared) {
        const context: Record<string, unknown> = {
          recordTables: prepared.records.tables.map((table) => ({
            documentId: table.documentId,
            documentName: table.documentName,
            kind: table.kind === "invoices" ? "invoice-register" : "payment-record",
            rows: table.rowCount,
            columns: table.table.columns.map((column) => column.name),
          })),
          ...(prepared.lowConfidencePages.length > 0
            ? { lowConfidencePages: prepared.lowConfidencePages }
            : {}),
        };

        return withoutRecordTables(buildSpecialistInput(ctx, context), prepared.recordTables);
      },
      toTaskOutput(result, ctx, prepared) {
        return documentAnalysisTaskOutput(
          { ...result, output: documentAnalysisOutputSchema.parse(result.output) },
          prepared,
          new Map(ctx.documentMetadata.map((metadata) => [metadata.id, metadata.name])),
        );
      },
    },
  );
}
