import { crc32, deflateSync } from "node:zlib";

import {
  createMockAi,
  IMAGE_EXTRACTION_KEY,
  mockImageExtractionStep,
  type AiClient,
  type MockAiClient,
  type MockScript,
  type MockStep,
} from "@evianta/ai";
import type { Case, CitationInput, DocumentMetadata } from "@evianta/core";
import { extractedDocumentSchema } from "@evianta/core";
import { extractDocumentAsync, ingestDocumentAsync } from "@evianta/ingest";
import {
  createInMemoryDocumentStore,
  createInMemoryStore,
  type DocumentStore,
  type Store,
} from "@evianta/store";
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { PriorFinding } from "../agents/specialist.js";
import type { TaskHandlerRegistry } from "../handlers.js";
import { createOrchestrator, type OrchestratorOptions } from "../orchestrator.js";
import { REFERENCE_PLANS } from "../plans.js";
import { createDefaultTaskHandlers } from "../registry.js";
import {
  registerMsmePaymentHandlers,
  type MsmePaymentHandlerOptions,
} from "../usecases/msme-payment/index.js";
import { readPaymentRecords, type PaymentCaseDocument } from "../usecases/msme-payment/records.js";
import { reconcilePayments } from "../usecases/msme-payment/reconcile.js";
import { resolveCreditTerms } from "../usecases/msme-payment/terms.js";

// Synthetic data only: the businesses, references, and URLs below are invented for tests.

export const MSME_AS_OF_DATE = "2025-03-31";

export const MSME_DOCUMENT_IDS = {
  purchaseOrder: "doc-po",
  agreement: "doc-agreement",
  deliveries: "doc-deliveries",
  correspondence: "doc-correspondence",
  invoices: "doc-invoices",
  payments: "doc-payments",
} as const;

export const PURCHASE_ORDER_PAGE = [
  "PURCHASE ORDER (SYNTHETIC TEST DOCUMENT)",
  "PO No: PO-4471 Date: 2024-09-02",
  "Buyer: Example Motors Pvt Ltd (synthetic)",
  "Supplier: Synthetic Precision Components (synthetic)",
  "Items: 1,650 machined brackets, total value Rs 4,95,000 including tax",
  "Delivery: in five lots, each against a separate invoice",
  "Payment terms: 60 days from the date of invoice",
];

export const AGREEMENT_PAGE = [
  "SUPPLY AGREEMENT (SYNTHETIC TEST DOCUMENT)",
  "Agreement No: SA-2024-07 Dated: 2024-08-26",
  "Between Example Motors Pvt Ltd (Buyer) and Synthetic Precision Components (Supplier)",
  "Clause 5. Delivery: goods are delivered with a challan signed by the Buyer's stores.",
  "Clause 7. Payment: The Buyer shall pay each invoice within 60 days of the date of invoice.",
  "Clause 12. Disputes: the parties shall first try to resolve any dispute by written notice.",
];

export const DELIVERY_PAGE = [
  "DELIVERY CHALLAN REGISTER (SYNTHETIC TEST DOCUMENT)",
  "DC-501 dated 2024-09-18: 300 brackets against INV-1001, received by buyer stores",
  "DC-502 dated 2024-10-14: 500 brackets against INV-1002, received by buyer stores",
  "DC-503 dated 2024-11-08: 400 brackets against INV-1003, received by buyer stores",
  "DC-504 dated 2024-12-04: 200 brackets against INV-1004, received by buyer stores",
];

export const CORRESPONDENCE_PAGE_ONE = [
  "CORRESPONDENCE (SYNTHETIC TEST DOCUMENT)",
  "2025-01-15 Email from Synthetic Precision Components (accounts) to Example Motors (purchase):",
  "Reminder that INV-1002 and INV-1003 are past their due dates. Please arrange payment.",
  "2025-02-05 Email from Example Motors (purchase) to Synthetic Precision Components:",
  "We dispute the quantity billed on INV-1003; 10 brackets were short-delivered.",
  "We will release the balance of INV-1003 after a credit note is issued.",
];

export const CORRESPONDENCE_SCANNED_TEXT =
  "Letter dated 2025-03-12 from Example Motors Pvt Ltd: we acknowledge invoice INV-1003 for Rs 1,18,000 and request a revised statement of account.";

export const CORRESPONDENCE_OCR_CONFIDENCE = 0.66;

export const INVOICES_CSV = [
  "Invoice No,Invoice Date,PO Ref,Amount (INR),Due Date",
  "INV-1001,2024-09-20,PO-4471,100000,2024-11-19",
  "INV-1002,2024-10-15,PO-4471,150000,2024-12-14",
  "INV-1003,2024-11-10,PO-4471,112000,2025-01-09",
  "INV-1004,2024-12-05,PO-4471,58000,2025-02-03",
  "INV-1005,2025-01-08,PO-4471,75000,2025-03-09",
].join("\n");

// Partial payments on INV-1002 and INV-1003, one payment without a reference that matches
// INV-1004 by amount, and one that references an invoice not in the register.
export const PAYMENTS_CSV = [
  "Payment Date,UTR / Reference,Invoice Ref,Amount Received,Narration",
  "2024-11-18,UTR24111801,INV-1001,100000,Full payment",
  "2024-12-20,UTR24122002,INV-1002,60000,Part payment",
  "2025-01-25,UTR25012503,,58000,NEFT from Example Motors",
  "2025-02-10,UTR25021004,INV-1002,40000,Part payment",
  "2025-02-28,UTR25022805,INV-1003,50000,Part payment",
  "2025-03-05,UTR25030506,INV-0999,5000,Adjustment",
].join("\n");

export const MSME_EXPECTED = {
  invoiced: 495_000,
  received: 308_000,
  outstanding: 187_000,
  unallocated: 5_000,
  byInvoice: {
    "INV-1001": 0,
    "INV-1002": 50_000,
    "INV-1003": 62_000,
    "INV-1004": 0,
    "INV-1005": 75_000,
  },
} as const;

export const MSME_CITATIONS: CitationInput[] = [
  {
    title: "MSMED Act 2006, section 15: liability of buyer to make payment (synthetic)",
    url: "https://msme-reference.example/msmed-act/section-15",
    snippet:
      "Section 15 requires the buyer to pay on or before the agreed date, which shall not exceed 45 days from the day of acceptance.",
  },
  {
    title: "Reference to the Micro and Small Enterprises Facilitation Council (synthetic)",
    url: "https://msme-reference.example/msmed-act/section-18",
    snippet:
      "Under section 18 a party to a dispute about amounts due may make a reference to the Facilitation Council.",
  },
  {
    title: "MSME Samadhaan delayed payment portal (synthetic)",
    url: "https://samadhaan-reference.example/portal",
    snippet:
      "Micro and small enterprises can file delayed payment applications on the Samadhaan portal.",
  },
];

export function msmeMetadata(id: string, name: string, mimeType = "text/csv"): DocumentMetadata {
  return {
    id,
    caseId: "case-msme",
    name,
    mimeType,
    size: 1,
    gcsPath: `cases/case-msme/${id}`,
    uploadedAt: "2025-03-31T00:00:00.000Z",
  };
}

/** A CSV document extracted by the real ingestion parser, without the store. */
export async function csvPaymentDocumentAsync(
  id: string,
  name: string,
  csv: string,
): Promise<PaymentCaseDocument> {
  const document = msmeMetadata(id, name);
  const { extraction } = await extractDocumentAsync(Buffer.from(csv, "utf8"), document, {
    ai: createMockAi({}),
  });

  return { metadata: document, extraction };
}

export function textPaymentDocument(
  id: string,
  name: string,
  pages: string[],
): PaymentCaseDocument {
  return {
    metadata: msmeMetadata(id, name, "application/pdf"),
    extraction: extractedDocumentSchema.parse({
      documentId: id,
      kind: "text",
      method: "pdf-text",
      confidence: 0.95,
      pages: pages.map((text, index) => ({
        index: index + 1,
        text,
        method: "pdf-text",
        confidence: 0.95,
      })),
    }),
  };
}

export const msmeAgreementDocument = (): PaymentCaseDocument =>
  textPaymentDocument("doc-agreement", "supply-agreement.pdf", [
    "SUPPLY AGREEMENT\nClause 7. Payment: The Buyer shall pay each invoice within 60 days of the date of invoice.",
  ]);

/** The agreement, invoice register, and payment records, reconciled as of the fixture date. */
export async function reconcileMsmeFixtureAsync(
  invoices = INVOICES_CSV,
  payments = PAYMENTS_CSV,
  asOfDate = MSME_AS_OF_DATE,
) {
  const documents = [
    msmeAgreementDocument(),
    await csvPaymentDocumentAsync(MSME_DOCUMENT_IDS.invoices, "invoices.csv", invoices),
    await csvPaymentDocumentAsync(MSME_DOCUMENT_IDS.payments, "payments.csv", payments),
  ];
  const records = readPaymentRecords(documents);

  return reconcilePayments(records, resolveCreditTerms(documents), { asOfDate });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

function blankPng(size = 16): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((size + 1) * size, 0xff);

  for (let row = 0; row < size; row += 1) {
    rows[row * (size + 1)] = 0;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PDF with one text-layer page per entry; `scannedPages` adds image-only pages like a scan. */
export async function createTextPdfAsync(
  pages: ReadonlyArray<readonly string[]>,
  scannedPages = 0,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);

    lines.forEach((line, index) => {
      page.drawText(line, { x: 40, y: 740 - index * 18, size: 9, font });
    });
  }

  if (scannedPages > 0) {
    const scan = await pdf.embedPng(blankPng());

    for (let index = 0; index < scannedPages; index += 1) {
      pdf.addPage([612, 792]).drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });
    }
  }

  return Buffer.from(await pdf.save());
}

export function msmeOcrStep(): MockStep {
  return mockImageExtractionStep({
    text: CORRESPONDENCE_SCANNED_TEXT,
    confidence: CORRESPONDENCE_OCR_CONFIDENCE,
    lines: [
      {
        text: CORRESPONDENCE_SCANNED_TEXT,
        bbox: { x: 0.08, y: 0.18, width: 0.84, height: 0.06 },
      },
    ],
  });
}

export interface MsmeUpload {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export async function uploadMsmeDocumentAsync(
  store: Store,
  documentStore: DocumentStore,
  ai: Pick<AiClient, "extractFromImageAsync">,
  caseId: string,
  upload: MsmeUpload,
): Promise<DocumentMetadata> {
  const gcsPath = await documentStore.uploadAsync(
    caseId,
    upload.name,
    upload.mimeType,
    upload.bytes,
  );
  const metadata = await store.documents.addDocumentMetadataAsync({
    id: upload.id,
    caseId,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.bytes.length,
    gcsPath,
    uploadedAt: "2025-03-31T09:00:00.000Z",
  });
  const result = await ingestDocumentAsync({
    caseId,
    document: metadata,
    store,
    documentStore,
    ai,
  });

  if (result.failedPages.length > 0) {
    throw new Error(`Fixture ingestion failed for pages ${result.failedPages.join(", ")}.`);
  }

  return metadata;
}

export async function createMsmeCaseAsync(store: Store, id = "case-msme"): Promise<Case> {
  return store.cases.createCaseAsync({
    id,
    title: "Synthetic overdue invoices from Example Motors",
    description:
      "Organize the records for overdue invoices under PO-4471 and prepare a case pack for follow-up.",
    useCase: "msme-payment",
    visitorId: "visitor-1",
  });
}

export interface MsmeUploads {
  /** Leave out the delivery challan register. */
  deliveries?: boolean;
  invoicesCsv?: string;
  paymentsCsv?: string | false;
}

/** Uploads and ingests the synthetic document set through the real ingestion layer. */
export async function seedMsmeDocumentsAsync(
  store: Store,
  caseId: string,
  ai: Pick<AiClient, "extractFromImageAsync">,
  uploads: MsmeUploads = {},
  documentStore: DocumentStore = createInMemoryDocumentStore(),
): Promise<DocumentMetadata[]> {
  const pdfs: Array<[string, string, Buffer]> = [
    [
      MSME_DOCUMENT_IDS.purchaseOrder,
      "purchase-order-po-4471.pdf",
      await createTextPdfAsync([PURCHASE_ORDER_PAGE]),
    ],
    [
      MSME_DOCUMENT_IDS.agreement,
      "supply-agreement.pdf",
      await createTextPdfAsync([AGREEMENT_PAGE]),
    ],
    ...(uploads.deliveries === false
      ? []
      : ([
          [
            MSME_DOCUMENT_IDS.deliveries,
            "delivery-challans.pdf",
            await createTextPdfAsync([DELIVERY_PAGE]),
          ],
        ] as Array<[string, string, Buffer]>)),
    [
      MSME_DOCUMENT_IDS.correspondence,
      "correspondence.pdf",
      await createTextPdfAsync([CORRESPONDENCE_PAGE_ONE], 1),
    ],
  ];
  const csvs: Array<[string, string, string | undefined]> = [
    [MSME_DOCUMENT_IDS.invoices, "invoices.csv", uploads.invoicesCsv ?? INVOICES_CSV],
    [
      MSME_DOCUMENT_IDS.payments,
      "payments.csv",
      uploads.paymentsCsv === false ? undefined : (uploads.paymentsCsv ?? PAYMENTS_CSV),
    ],
  ];
  const documents: DocumentMetadata[] = [];

  for (const [id, name, bytes] of pdfs) {
    documents.push(
      await uploadMsmeDocumentAsync(store, documentStore, ai, caseId, {
        id,
        name,
        mimeType: "application/pdf",
        bytes,
      }),
    );
  }

  for (const [id, name, content] of csvs) {
    if (content !== undefined) {
      documents.push(
        await uploadMsmeDocumentAsync(store, documentStore, ai, caseId, {
          id,
          name,
          mimeType: "text/csv",
          bytes: Buffer.from(content, "utf8"),
        }),
      );
    }
  }

  return documents;
}

const source = (documentId: string, quote: string, page = 1) => ({ documentId, page, quote });

export function documentAnalysisStep(): MockStep {
  const { purchaseOrder, agreement, deliveries, correspondence, invoices, payments } =
    MSME_DOCUMENT_IDS;

  return {
    output: {
      documents: [
        {
          documentId: purchaseOrder,
          kind: "purchase-order",
          reference: "PO-4471",
          date: "2024-09-02",
          parties: ["Example Motors Pvt Ltd", "Synthetic Precision Components"],
          summary: "Order for 1,650 machined brackets with payment 60 days from invoice",
          source: source(purchaseOrder, "PO No: PO-4471 Date: 2024-09-02"),
        },
        {
          documentId: agreement,
          kind: "agreement",
          reference: "SA-2024-07",
          date: "2024-08-26",
          parties: ["Example Motors Pvt Ltd", "Synthetic Precision Components"],
          summary: "Supply agreement with payment, delivery, and dispute clauses",
          source: source(agreement, "Agreement No: SA-2024-07 Dated: 2024-08-26"),
        },
        {
          documentId: deliveries,
          kind: "delivery-record",
          summary: "Delivery challans DC-501 to DC-504",
          source: source(deliveries, "DELIVERY CHALLAN REGISTER"),
        },
        {
          documentId: correspondence,
          kind: "correspondence",
          summary: "Reminder, dispute email, and a scanned acknowledgement letter",
          source: source(correspondence, "CORRESPONDENCE"),
        },
        { documentId: invoices, kind: "invoice-register", summary: "Invoice register" },
        { documentId: payments, kind: "payment-record", summary: "Payments received" },
      ],
      paymentTerms: [
        {
          creditDays: 60,
          description: "Clause 7: payment within 60 days of the date of invoice",
          source: source(
            agreement,
            "The Buyer shall pay each invoice within 60 days of the date of invoice.",
          ),
        },
      ],
      invoices: [
        {
          invoiceNumber: "INV-1003",
          amount: 118000,
          source: source(correspondence, "we acknowledge invoice INV-1003 for Rs 1,18,000", 2),
        },
      ],
      deliveries: [
        ["DC-501", "2024-09-18", "INV-1001", "300"],
        ["DC-502", "2024-10-14", "INV-1002", "500"],
        ["DC-503", "2024-11-08", "INV-1003", "400"],
        ["DC-504", "2024-12-04", "INV-1004", "200"],
      ].map(([reference, date, invoice, quantity]) => ({
        reference,
        date,
        invoiceRefs: [invoice],
        description: `${quantity} brackets received by buyer stores`,
        source: source(
          deliveries,
          `${reference} dated ${date}: ${quantity} brackets against ${invoice}, received by buyer stores`,
        ),
      })),
      correspondence: [
        {
          date: "2025-01-15",
          sender: "Synthetic Precision Components (accounts)",
          recipient: "Example Motors (purchase)",
          summary: "reminder that INV-1002 and INV-1003 are past their due dates",
          invoiceRefs: ["INV-1002", "INV-1003"],
          source: source(
            correspondence,
            "Reminder that INV-1002 and INV-1003 are past their due dates.",
          ),
        },
        {
          date: "2025-02-05",
          sender: "Example Motors (purchase)",
          recipient: "Synthetic Precision Components",
          summary:
            "disputes the quantity billed on INV-1003 and will release the balance after a credit note",
          invoiceRefs: ["INV-1003"],
          source: source(
            correspondence,
            "We dispute the quantity billed on INV-1003; 10 brackets were short-delivered.",
          ),
        },
        {
          date: "2025-03-12",
          sender: "Example Motors Pvt Ltd",
          summary:
            "acknowledges INV-1003 for Rs 1,18,000 and requests a revised statement of account",
          invoiceRefs: ["INV-1003"],
          source: source(correspondence, "we acknowledge invoice INV-1003 for Rs 1,18,000", 2),
        },
      ],
    },
    usage: { input: 2200, output: 900 },
  };
}

export function paymentReconciliationStep(): MockStep {
  return {
    output: {
      summary:
        "Three invoices carry a balance. Two were part paid, one is unpaid, and one payment refers to an invoice that is not in the register.",
      explanations: [
        {
          invoiceNumber: "INV-1002",
          explanation: "Two part payments leave a balance on this invoice.",
          followUp: "Ask the buyer when the balance of INV-1002 will be released.",
        },
        {
          invoiceNumber: "INV-1003",
          explanation: "One part payment was received; the buyer disputes the quantity.",
          followUp: "Resolve the quantity dispute on INV-1003 with the delivery challan.",
        },
        {
          invoiceNumber: "INV-1004",
          explanation: "A payment without an invoice reference equals this invoice.",
          followUp: "Ask the buyer for the remittance advice of UTR25012503.",
        },
        {
          invoiceNumber: "INV-1005",
          explanation: "No payment has been received.",
        },
      ],
    },
    usage: { input: 1800, output: 500 },
  };
}

export function evidenceAnalysisStep(): MockStep {
  return {
    output: {
      summary:
        "The invoices are supported by the purchase order, agreement, and delivery challans except INV-1005. The buyer disputes the quantity on INV-1003.",
      disputedItems: [
        {
          invoiceNumbers: ["INV-1003"],
          description:
            "The buyer says 10 brackets were short-delivered and is holding the balance until a credit note is issued",
          raisedBy: "Example Motors (purchase)",
          date: "2025-02-05",
          source: source(
            MSME_DOCUMENT_IDS.correspondence,
            "We dispute the quantity billed on INV-1003; 10 brackets were short-delivered.",
          ),
        },
      ],
    },
    usage: { input: 2000, output: 400 },
  };
}

export function legalResearchStep(): MockStep {
  const conditions = [
    "the supplier's Udyam registration was in force when the goods were supplied",
    "the date on which the buyer accepted each delivery",
  ];

  return {
    output: {
      summary: "Contractual and statutory routes that may be relevant to the overdue invoices.",
      routes: [
        {
          name: "Buyer's liability to pay within the agreed period",
          kind: "statutory",
          reference: "MSMED Act, 2006, section 15",
          summary: "The agreed payment period may not exceed 45 days from acceptance.",
          relevance: "The agreement allows 60 days.",
          conditions,
          sourceUrls: ["https://msme-reference.example/msmed-act/section-15"],
        },
        {
          name: "Compound interest on delayed payments",
          kind: "statutory",
          reference: "MSMED Act, 2006, section 16",
          summary: "Interest may accrue on amounts paid after the appointed day.",
          sourceUrls: [],
        },
        {
          name: "Reference to the Micro and Small Enterprises Facilitation Council",
          kind: "procedural",
          reference: "MSMED Act, 2006, section 18",
          summary: "A party may refer a dispute about amounts due to the Facilitation Council.",
          conditions,
          sourceUrls: ["https://msme-reference.example/msmed-act/overview"],
        },
        {
          name: "MSME Samadhaan delayed-payment portal",
          kind: "procedural",
          summary: "An online channel for delayed-payment applications.",
          sourceUrls: ["https://samadhaan-reference.example/portal"],
        },
        {
          name: "Written notice under the dispute clause",
          kind: "contractual",
          reference: "Supply agreement SA-2024-07, clause 12",
          summary: "The parties must first try to resolve a dispute by written notice.",
          documentSources: [
            source(
              MSME_DOCUMENT_IDS.agreement,
              "Clause 12. Disputes: the parties shall first try to resolve any dispute by written notice.",
            ),
          ],
        },
      ],
    },
    citations: MSME_CITATIONS,
    usage: { input: 1500, output: 700 },
  };
}

export function msmeReviewStep(): MockStep {
  return {
    output: {
      findings: [],
      openQuestions: [
        {
          text: "Confirm whether a credit note for the INV-1003 shortfall should be offered before any escalation.",
          severity: "medium",
        },
      ],
      section: {
        title: "Review summary",
        kind: "text",
        content: "The draft is consistent with the reconciliation and the chronology.",
      },
    },
    usage: { input: 5000, output: 500 },
  };
}

export function msmeCoordinatorStep(): MockStep {
  return {
    output: {
      tasks: REFERENCE_PLANS["msme-payment"].tasks.map((task) => ({
        assignedRole: task.assignedRole,
        title: task.title,
        dependsOn: [...task.dependsOn],
      })),
      openQuestions: [],
    },
    usage: { input: 900, output: 250 },
  };
}

export function msmePaymentScript(overrides: MockScript = {}): MockScript {
  return {
    [IMAGE_EXTRACTION_KEY]: msmeOcrStep(),
    coordinator: msmeCoordinatorStep(),
    "document-analysis": documentAnalysisStep(),
    "payment-reconciliation": paymentReconciliationStep(),
    "evidence-analysis": evidenceAnalysisStep(),
    "legal-research": legalResearchStep(),
    "independent-review": msmeReviewStep(),
    ...overrides,
  };
}

export interface MsmeDraftOptions {
  /** Seeds a wrong total: the draft and a finding state Rs 1,97,000 instead of Rs 1,87,000. */
  wrongTotal?: boolean;
  /** Adds a sentence claiming a reference was filed. */
  escalationClaim?: boolean;
}

function idsWhere(
  priorFindings: readonly PriorFinding[],
  predicate: (finding: PriorFinding) => boolean,
): string[] {
  return priorFindings.filter(predicate).map((finding) => finding.findingId);
}

/** A follow-up draft that cites the real finding ids the model would see in priorFindings. */
export function followUpDraftOutput(
  priorFindings: readonly PriorFinding[],
  options: MsmeDraftOptions = {},
) {
  const totalIds = idsWhere(priorFindings, (finding) =>
    finding.summary.startsWith("Outstanding amount:"),
  );
  const lineIds = idsWhere(
    priorFindings,
    (finding) => finding.role === "payment-reconciliation" && finding.summary.startsWith("[INV-"),
  );
  const disputeIds = idsWhere(priorFindings, (finding) => finding.summary.includes("Disputed:"));
  const total = options.wrongTotal ? "1,97,000" : "1,87,000";

  return {
    draft: {
      kind: "follow-up",
      subject: `Overdue invoices under PO-4471: Rs ${total} outstanding as of 2025-03-31`,
      salutation: "Dear Accounts Team, Example Motors Pvt Ltd,",
      parts: [
        {
          title: "Outstanding position",
          content: `As of 31 March 2025, Rs ${total} remains outstanding across INV-1002 (Rs 50,000), INV-1003 (Rs 62,000), and INV-1005 (Rs 75,000).`,
          findingIds: [...totalIds, ...lineIds.slice(0, 3)],
        },
        {
          title: "Payments received",
          content:
            "We acknowledge Rs 60,000 on 20 December 2024 and Rs 40,000 on 10 February 2025 against INV-1002, Rs 50,000 on 28 February 2025 against INV-1003, and Rs 58,000 on 25 January 2025, which we have applied to INV-1004. Please confirm this allocation.",
          findingIds: lineIds,
        },
        {
          title: "Items to resolve",
          content: `You raised a quantity shortfall on INV-1003 on 5 February 2025; we will review the delivery records with you. Please also share the remittance details of the Rs 5,000 payment on 5 March 2025, which refers to an invoice we cannot trace.${options.escalationClaim ? " A reference has been filed with the Facilitation Council." : ""}`,
          findingIds: [...disputeIds, "not-a-finding"],
        },
        {
          title: "Requested action",
          content:
            "We request payment of the undisputed balance within 15 days of this letter, or a call to agree a payment schedule.",
          findingIds: [],
        },
      ],
      closing: "Regards, Accounts, Synthetic Precision Components",
    },
    findings: options.wrongTotal
      ? [
          {
            summary: "Outstanding total stated in the draft",
            severity: "medium",
            confidence: "medium",
            evidence: [],
            figures: [
              {
                key: "outstanding-total",
                label: "Outstanding in the draft",
                value: 197000,
                components: [
                  { label: "INV-1002", value: 50000 },
                  { label: "INV-1003", value: 62000 },
                  { label: "INV-1005", value: 75000 },
                ],
              },
            ],
          },
        ]
      : [],
    openQuestions: [
      {
        text: "Decide whether to offer a credit note for the INV-1003 shortfall before escalating.",
        severity: "medium",
      },
    ],
  };
}

/** Wraps a mock client so the case-preparation output is built from the prompt's findings. */
export function withDynamicFollowUpDraft(
  ai: MockAiClient,
  options: MsmeDraftOptions = {},
): MockAiClient {
  return {
    ...ai,
    async runStructuredAsync(request) {
      if (request.key === "case-preparation") {
        const input = request.input as { priorFindings?: PriorFinding[] };

        ai.script("case-preparation", {
          output: followUpDraftOutput(input.priorFindings ?? [], options),
          usage: { input: 3000, output: 1100 },
        });
      }

      return ai.runStructuredAsync(request);
    },
  };
}

export function createMsmePaymentAi(overrides: MockScript = {}, options: MsmeDraftOptions = {}) {
  const mock = createMockAi(msmePaymentScript(overrides));

  return { mock, ai: withDynamicFollowUpDraft(mock, options) };
}

export function msmeTaskHandlers(
  options: MsmePaymentHandlerOptions = { reconciliation: { asOfDate: MSME_AS_OF_DATE } },
): TaskHandlerRegistry {
  return registerMsmePaymentHandlers(createDefaultTaskHandlers(), options);
}

export interface MsmeHarnessOptions {
  script?: MockScript;
  draft?: MsmeDraftOptions;
  uploads?: MsmeUploads;
  orchestrator?: Partial<Omit<OrchestratorOptions, "store" | "ai">>;
}

export async function createMsmeHarnessAsync(options: MsmeHarnessOptions = {}) {
  const store = createInMemoryStore();
  const { mock, ai } = createMsmePaymentAi(options.script, options.draft);
  let counter = 0;
  const orchestrator = createOrchestrator({
    store,
    ai,
    handlers: msmeTaskHandlers(),
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
    ...options.orchestrator,
  });
  const caseRecord = await createMsmeCaseAsync(store);

  await seedMsmeDocumentsAsync(store, caseRecord.id, mock, options.uploads);

  const readAsync = async () => {
    const [tasks, findings, evidence, deliverables, events] = await Promise.all([
      store.tasks.getTasksForCaseAsync(caseRecord.id),
      store.findings.getFindingsForCaseAsync(caseRecord.id),
      store.evidence.getEvidenceForCaseAsync(caseRecord.id),
      store.deliverables.getDeliverablesForCaseAsync(caseRecord.id),
      store.events.listEventsAsync(caseRecord.id),
    ]);

    return { tasks, findings, evidence, deliverables, events };
  };

  return { store, mock, orchestrator, caseRecord, readAsync };
}
