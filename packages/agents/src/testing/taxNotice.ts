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
import { ingestDocumentAsync } from "@evianta/ingest";
import { createInMemoryDocumentStore, type DocumentStore, type Store } from "@evianta/store";
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { PriorFinding } from "../agents/specialist.js";
import { REFERENCE_PLANS } from "../plans.js";

// Synthetic data only: the taxpayer, TANs, DIN, and URLs below are invented for tests.

export const NOTICE_PAGE_ONE = [
  "INCOME TAX DEPARTMENT (SYNTHETIC TEST NOTICE)",
  "Intimation under section 143(1) of the Income-tax Act, 1961",
  "DIN: SYN/CPC/2025/000001",
  "Assessee: Synthetic Taxpayer One   PAN: AAAPZ9999Z",
  "Assessment Year: 2024-25",
  "Date of issue: 2025-01-15",
  "Response due by: 2025-02-14",
  "TDS credit claimed in the return has been restricted to Form 26AS under section 143(1)(a).",
  "TDS claimed in return: Rs 1,41,000",
  "TDS as per Form 26AS: Rs 1,28,600",
  "TDS credit disallowed: Rs 12,400",
  "Interest under sections 234B and 234C: Rs 620",
  "Demand payable: Rs 13,020",
  "Furnish TDS certificates in Form 16A and a reconciliation of TDS claimed with Form 26AS.",
];

export const NOTICE_SCANNED_PAGE_TEXT = [
  "Annexure: deductor-wise TDS adjustment",
  "DELS20002B Sunrise Consulting Pvt Ltd 194J claimed 50,000 allowed 37,600",
].join("\n");

export const NOTICE_OCR_CONFIDENCE = 0.68;

export const TAX_CREDIT_CSV = [
  "TAN of deductor,Name of deductor,Section,Transaction date,Amount paid/credited,Tax deducted,Booking status",
  "MUMN10001A,Northwind Bank Ltd,194A,2023-09-30,4000,400,F",
  "MUMN10001A,Northwind Bank Ltd,194A,2024-03-31,6000,600,F",
  "DELS20002B,Sunrise Consulting Pvt Ltd,194J,2023-06-30,125000,12500,F",
  "DELS20002B,Sunrise Consulting Pvt Ltd,194J,2023-09-30,125000,12500,F",
  "DELS20002B,Sunrise Consulting Pvt Ltd,194J,2023-12-31,126000,12600,F",
  "BLRA30003C,Asha Salaries Ltd,192,2023-06-30,225000,22500,F",
  "BLRA30003C,Asha Salaries Ltd,192,2023-09-30,225000,22500,F",
  "BLRA30003C,Asha Salaries Ltd,192,2023-12-31,225000,22500,F",
  "BLRA30003C,Asha Salaries Ltd,192,2024-03-31,225000,22500,F",
].join("\n");

// The ledger has no TAN column, so rows are matched to the 26AS TAN by deductor name.
export const LEDGER_CSV = [
  "Date,Party,Section,Gross amount,TDS deducted,Voucher",
  "2023-09-30,Northwind Bank Ltd,194A,4000,400,INT-01",
  "2024-03-31,Northwind Bank Ltd,194A,6000,600,INT-02",
  "2023-06-30,Sunrise Consulting Pvt Ltd,194J,125000,12500,PF-01",
  "2023-09-30,Sunrise Consulting Pvt Ltd,194J,125000,12500,PF-02",
  "2023-12-31,Sunrise Consulting Pvt Ltd,194J,126000,12600,PF-03",
  "2024-03-31,Sunrise Consulting Pvt Ltd,194J,124000,12400,PF-04",
  "2023-06-30,Asha Salaries Ltd,192,225000,22500,SAL-Q1",
  "2023-09-30,Asha Salaries Ltd,192,225000,22500,SAL-Q2",
  "2023-12-31,Asha Salaries Ltd,192,225000,22500,SAL-Q3",
  "2024-03-31,Asha Salaries Ltd,192,225000,22500,SAL-Q4",
].join("\n");

// Seeded discrepancy: the return claims Rs 50,000 TDS from Sunrise; 26AS shows Rs 37,600.
export const RETURN_COMPUTATION_CSV = [
  "TAN,Deductor,Section,Financial year,Income offered,TDS claimed",
  "MUMN10001A,Northwind Bank Ltd,194A,2023-24,10000,1000",
  "DELS20002B,Sunrise Consulting Pvt Ltd,194J,2023-24,500000,50000",
  "BLRA30003C,Asha Salaries Ltd,192,2023-24,900000,90000",
].join("\n");

export const DOCUMENT_IDS = {
  notice: "doc-notice",
  taxCredit: "doc-26as",
  ledger: "doc-ledger",
  returnComputation: "doc-return",
} as const;

export const CITATIONS: CitationInput[] = [
  {
    title: "Section 143 of the Income-tax Act (synthetic)",
    url: "https://tax-reference.example/act/section-143",
    snippet: "Section 143(1)(a) allows adjustments for incorrect claims apparent from the return.",
  },
  {
    title: "Section 199: credit for tax deducted (synthetic)",
    url: "https://tax-reference.example/act/section-199",
    snippet:
      "Credit for tax deducted is given on the basis of the information furnished by the deductor.",
  },
];

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

function scannedPagePng(size = 16): Buffer {
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

/** A two-page notice: page 1 has a text layer, page 2 is an image only, like a scan. */
export async function createNoticePdfAsync(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const textPage = pdf.addPage([612, 792]);

  NOTICE_PAGE_ONE.forEach((line, index) => {
    textPage.drawText(line, { x: 48, y: 740 - index * 18, size: 10, font });
  });

  const scan = await pdf.embedPng(scannedPagePng());

  pdf.addPage([612, 792]).drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });

  return Buffer.from(await pdf.save());
}

export function ocrStep(): MockStep {
  return mockImageExtractionStep({
    text: NOTICE_SCANNED_PAGE_TEXT,
    confidence: NOTICE_OCR_CONFIDENCE,
    lines: [
      {
        text: "DELS20002B Sunrise Consulting Pvt Ltd 194J claimed 50,000 allowed 37,600",
        bbox: { x: 0.08, y: 0.2, width: 0.8, height: 0.04 },
      },
    ],
  });
}

export interface UploadInput {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export async function uploadAndIngestAsync(
  store: Store,
  documentStore: DocumentStore,
  ai: Pick<AiClient, "extractFromImageAsync">,
  caseId: string,
  upload: UploadInput,
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
    uploadedAt: "2025-01-20T10:00:00.000Z",
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

export interface TaxNoticeUploads {
  notice?: boolean;
  taxCredit?: string | false;
  ledger?: string | false;
  returnComputation?: string | false;
}

export async function createTaxNoticeCaseAsync(store: Store, id = "case-tax"): Promise<Case> {
  return store.cases.createCaseAsync({
    id,
    title: "Synthetic 143(1) intimation for AY 2024-25",
    description: "Prepare a response to a TDS credit mismatch intimation for CA review.",
    useCase: "tax-notice",
    visitorId: "visitor-1",
  });
}

/** Uploads and ingests the synthetic notice and records through the real ingestion layer. */
export async function seedTaxNoticeDocumentsAsync(
  store: Store,
  caseId: string,
  ai: Pick<AiClient, "extractFromImageAsync">,
  uploads: TaxNoticeUploads = {},
  documentStore: DocumentStore = createInMemoryDocumentStore(),
): Promise<DocumentMetadata[]> {
  const documents: DocumentMetadata[] = [];
  const csv = (value: string | false | undefined, fallback: string) =>
    value === false ? undefined : (value ?? fallback);

  if (uploads.notice !== false) {
    documents.push(
      await uploadAndIngestAsync(store, documentStore, ai, caseId, {
        id: DOCUMENT_IDS.notice,
        name: "notice-143-1.pdf",
        mimeType: "application/pdf",
        bytes: await createNoticePdfAsync(),
      }),
    );
  }

  const tables: Array<[string, string, string | undefined]> = [
    [DOCUMENT_IDS.taxCredit, "form-26as.csv", csv(uploads.taxCredit, TAX_CREDIT_CSV)],
    [DOCUMENT_IDS.ledger, "ledger.csv", csv(uploads.ledger, LEDGER_CSV)],
    [
      DOCUMENT_IDS.returnComputation,
      "itr-computation.csv",
      csv(uploads.returnComputation, RETURN_COMPUTATION_CSV),
    ],
  ];

  for (const [id, name, content] of tables) {
    if (content !== undefined) {
      documents.push(
        await uploadAndIngestAsync(store, documentStore, ai, caseId, {
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

const noticeSource = (quote: string, page = 1) => ({
  documentId: DOCUMENT_IDS.notice,
  page,
  quote,
});

export function caseAnalysisStep(): MockStep {
  return {
    output: {
      notice: {
        noticeType: "Intimation under section 143(1)",
        referenceNumber: "SYN/CPC/2025/000001",
        assessmentYear: "2024-25",
        sectionsCited: [
          {
            section: "143(1)(a)",
            context: "TDS credit restricted",
            source: noticeSource("under section 143(1)(a)"),
          },
          { section: "234B", source: noticeSource("Interest under sections 234B and 234C") },
          { section: "234C", source: noticeSource("Interest under sections 234B and 234C") },
        ],
        dates: [
          {
            key: "notice-issue-date",
            label: "Date of issue",
            date: "2025-01-15",
            source: noticeSource("Date of issue: 2025-01-15"),
          },
          {
            key: "due",
            label: "Response due by",
            date: "2025-02-14",
            source: noticeSource("Response due by: 2025-02-14"),
          },
        ],
        demandedFigures: [
          {
            key: "tds-claimed-return",
            label: "TDS claimed in return",
            amount: 141000,
            source: noticeSource("TDS claimed in return: Rs 1,41,000"),
          },
          {
            key: "tds-as-per-26as",
            label: "TDS as per Form 26AS",
            amount: 128600,
            source: noticeSource("TDS as per Form 26AS: Rs 1,28,600"),
          },
          {
            key: "tds-difference",
            label: "TDS credit disallowed",
            amount: 12400,
            source: noticeSource("TDS credit disallowed: Rs 12,400"),
          },
          {
            key: "demand-interest",
            label: "Interest under sections 234B and 234C",
            amount: 620,
            source: noticeSource("Interest under sections 234B and 234C: Rs 620"),
          },
          {
            key: "demand-total",
            label: "Demand payable",
            amount: 13020,
            components: [
              { label: "TDS credit disallowed", value: 12400 },
              { label: "Interest", value: 620 },
            ],
            source: noticeSource("Demand payable: Rs 13,020"),
          },
        ],
        issues: [
          {
            title: "TDS credit restricted to Form 26AS",
            description:
              "The TDS claimed in the return exceeds the credit in Form 26AS by Rs 12,400 and the excess was disallowed.",
            severity: "high",
            sections: ["143(1)(a)"],
            source: noticeSource(
              "TDS credit claimed in the return has been restricted to Form 26AS",
            ),
          },
          {
            title: "Adjustment relates to Sunrise Consulting Pvt Ltd",
            description: "The annexure attributes the adjustment to TAN DELS20002B.",
            severity: "medium",
            sections: [],
            source: noticeSource(
              "DELS20002B Sunrise Consulting Pvt Ltd 194J claimed 50,000 allowed 37,600",
              2,
            ),
          },
        ],
        requestedInformation: [
          {
            item: "TDS certificates in Form 16A",
            source: noticeSource("Furnish TDS certificates in Form 16A"),
          },
          {
            item: "Reconciliation of TDS claimed with Form 26AS",
            source: noticeSource("a reconciliation of TDS claimed with Form 26AS"),
          },
        ],
      },
    },
    usage: { input: 1800, output: 600 },
  };
}

export function reconciliationStep(): MockStep {
  return {
    output: {
      summary: "Two deductors agree across all records; Sunrise Consulting differs by one quarter.",
      explanations: [
        {
          ref: "R-03",
          explanation:
            "The ledger and the return include a fourth-quarter receipt from Sunrise Consulting that is not in Form 26AS.",
          likelyCause:
            "The deductor has not reported the January to March quarter in its TDS statement.",
          followUp:
            "Ask Sunrise Consulting to file a correction statement for Q4 FY 2023-24 and obtain Form 16A.",
          confidence: "medium",
        },
      ],
    },
    usage: { input: 1500, output: 400 },
  };
}

export function taxResearchStep(): MockStep {
  return {
    output: {
      summary: "Provisions on adjustments at processing and on TDS credit.",
      provisions: [
        {
          reference: "Section 143(1)(a)",
          title: "Adjustments while processing the return",
          summary: "Allows adjustments for incorrect claims apparent from the return.",
          relevance: "The intimation restricts the TDS credit under this provision.",
          sourceUrls: ["https://tax-reference.example/act/section-143"],
        },
        {
          reference: "Section 199",
          title: "Credit for tax deducted",
          summary: "Credit is given on the basis of information furnished by the deductor.",
          relevance: "Credit for the unreported quarter depends on the deductor's statement.",
          sourceUrls: ["https://tax-reference.example/other/page"],
        },
        {
          reference: "Rule 37BA",
          title: "Credit for tax deducted at source",
          summary: "Sets out how TDS credit is allowed.",
          sourceUrls: [],
        },
      ],
    },
    citations: CITATIONS,
    usage: { input: 1200, output: 500 },
  };
}

export function reviewStep(): MockStep {
  return {
    output: {
      findings: [],
      openQuestions: [
        {
          text: "Confirm whether the Q4 correction statement can be obtained before the due date.",
          severity: "medium",
        },
      ],
      section: {
        title: "Review summary",
        kind: "text",
        content: "The draft is consistent with the reconciliation.",
      },
    },
    usage: { input: 4000, output: 500 },
  };
}

export function coordinatorStep(): MockStep {
  return {
    output: {
      tasks: REFERENCE_PLANS["tax-notice"].tasks.map((task) => ({
        assignedRole: task.assignedRole,
        title: task.title,
        dependsOn: [...task.dependsOn],
      })),
      openQuestions: [],
    },
    usage: { input: 900, output: 200 },
  };
}

export function taxNoticeScript(overrides: MockScript = {}): MockScript {
  return {
    [IMAGE_EXTRACTION_KEY]: ocrStep(),
    coordinator: coordinatorStep(),
    "case-analysis": caseAnalysisStep(),
    reconciliation: reconciliationStep(),
    "tax-research": taxResearchStep(),
    "independent-review": reviewStep(),
    ...overrides,
  };
}

function findingIdWhere(
  priorFindings: readonly PriorFinding[],
  predicate: (finding: PriorFinding) => boolean,
): string[] {
  return priorFindings.filter(predicate).map((finding) => finding.findingId);
}

export interface DraftOptions {
  /** Seeds an arithmetic error: the stated difference is Rs 12,000 instead of Rs 12,400. */
  arithmeticError?: boolean;
  filingClaim?: boolean;
}

/** A draft that cites the real finding ids the model would see in priorFindings. */
export function responseDraftOutput(
  priorFindings: readonly PriorFinding[],
  options: DraftOptions = {},
) {
  const mismatchIds = findingIdWhere(priorFindings, (finding) =>
    finding.summary.startsWith("[R-03]"),
  );
  const noticeIds = findingIdWhere(priorFindings, (finding) => finding.role === "case-analysis");
  const researchIds = findingIdWhere(priorFindings, (finding) => finding.role === "tax-research");
  const difference = options.arithmeticError ? "12,000" : "12,400";

  return {
    draft: {
      subject:
        "Response to intimation under section 143(1) for AY 2024-25 (DIN SYN/CPC/2025/000001)",
      salutation: "To the Assessing Officer,",
      parts: [
        {
          title: "TDS credit claimed",
          content: `The return claims TDS of Rs 1,41,000 against Rs 1,28,600 shown in Form 26AS, a difference of Rs ${difference}. The difference relates to the fourth-quarter receipt from Sunrise Consulting Pvt Ltd (R-03), which appears in the books and the return.`,
          findingIds: [...mismatchIds, ...noticeIds.slice(0, 1)],
          scheduleRefs: ["Schedule A", "Schedule B"],
        },
        {
          title: "Interest and demand",
          content: `The demand of Rs 13,020 includes interest of Rs 620 that follows from the disallowed credit.${options.filingClaim ? " A revised return has been filed." : ""}`,
          findingIds: [...noticeIds.slice(0, 1), ...researchIds.slice(0, 1), "not-a-finding"],
          scheduleRefs: ["Schedule B"],
        },
      ],
      closing: "We request that the credit be allowed once the deductor's correction is reflected.",
    },
    findings: options.arithmeticError
      ? [
          {
            summary: "TDS difference stated in the draft",
            severity: "medium",
            confidence: "medium",
            evidence: [],
            figures: [
              {
                key: "tds-difference",
                label: "TDS difference in the draft",
                value: 12000,
                components: [
                  { label: "TDS claimed", value: 141000 },
                  { label: "TDS per 26AS", value: -128600 },
                ],
              },
            ],
          },
        ]
      : [],
    openQuestions: [
      {
        text: "Confirm whether the response should request rectification under section 154.",
        severity: "medium",
      },
    ],
  };
}

/** Wraps a mock client so the response-preparation output is built from the prompt's findings. */
export function withDynamicDraft(ai: MockAiClient, options: DraftOptions = {}): MockAiClient {
  return {
    ...ai,
    async runStructuredAsync(request) {
      if (request.key === "response-preparation") {
        const input = request.input as { priorFindings?: PriorFinding[] };

        ai.script("response-preparation", {
          output: responseDraftOutput(input.priorFindings ?? [], options),
          usage: { input: 2500, output: 900 },
        });
      }

      return ai.runStructuredAsync(request);
    },
  };
}

export function createTaxNoticeAi(overrides: MockScript = {}, options: DraftOptions = {}) {
  const mock = createMockAi(taxNoticeScript(overrides));

  return { mock, ai: withDynamicDraft(mock, options) };
}
