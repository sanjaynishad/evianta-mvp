import type { UseCase } from "@evianta/core";

export type ChecklistRequirement = "recommended" | "optional";

export interface ChecklistItem {
  id: string;
  label: string;
  hint: string;
  requirement: ChecklistRequirement;
  // Lowercase words matched against the start of each word in a file name.
  keywords: string[];
  extensions?: string[];
  accept?: string;
}

export interface UseCaseDefinition {
  id: UseCase;
  title: string;
  outcome: string;
  exampleTitle: string;
  exampleDescription: string;
  checklist: ChecklistItem[];
}

// Mirrors SUPPORTED_MIME_TYPES in @evianta/ingest, which the API enforces on upload.
export const supportedUploadMimeTypes = [
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const supportedUploadExtensions = [
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xlsx",
  "xls",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export const unsupportedUploadMessage =
  "This file type is not supported. Upload CSV, TSV, Excel (.xlsx, .xls), JSON (.json, .jsonl), PDF, PNG, JPEG, or WebP files.";

const spreadsheetAccept = ".xlsx,.xls,.csv,.tsv,.json,.jsonl,.ndjson";
const documentAccept = ".pdf,.png,.jpg,.jpeg,.webp";
const anyAccept = [
  ...supportedUploadExtensions.map((extension) => `.${extension}`),
  ...supportedUploadMimeTypes,
].join(",");

export const useCaseDefinitions: Record<UseCase, UseCaseDefinition> = {
  "data-analysis": {
    id: "data-analysis",
    title: "Business data analysis",
    outcome:
      "A findings report with key metrics, trends, anomalies, and data-quality notes, plus an interactive dashboard.",
    exampleTitle: "Quarterly sales review",
    exampleDescription:
      "Review last quarter's sales by month, region, and product. Highlight growth, unusual returns, and any data-quality problems.",
    checklist: [
      {
        id: "sales-data",
        label: "Sales data (Excel, CSV, or JSON)",
        hint: "Invoice or order lines with date, amount, region, and product.",
        requirement: "recommended",
        keywords: ["sales", "orders", "invoices", "transactions", "revenue"],
        extensions: ["csv", "tsv", "xlsx", "xls", "json", "jsonl", "ndjson"],
        accept: spreadsheetAccept,
      },
      {
        id: "master-data",
        label: "Product or customer list",
        hint: "Helps group sales by category or customer segment.",
        requirement: "optional",
        keywords: ["product", "customer", "master", "catalog", "catalogue"],
        accept: spreadsheetAccept,
      },
      {
        id: "targets",
        label: "Targets or budget",
        hint: "Lets the report compare actuals with plan.",
        requirement: "optional",
        keywords: ["target", "budget", "plan", "forecast"],
        accept: spreadsheetAccept,
      },
    ],
  },
  "tax-notice": {
    id: "tax-notice",
    title: "Income-tax notice response",
    outcome:
      "A response pack: the issues raised, a reconciliation of income and TDS, the applicable provisions, and a draft reply for your review.",
    exampleTitle: "Notice under section 143(1)(a)",
    exampleDescription:
      "Prepare a response to the intimation proposing an adjustment for a TDS mismatch between Form 26AS and the return for AY 2025-26.",
    checklist: [
      {
        id: "notice",
        label: "Notice (PDF or scan)",
        hint: "The notice or intimation exactly as received.",
        requirement: "recommended",
        keywords: ["notice", "intimation", "143", "148", "demand"],
        accept: documentAccept,
      },
      {
        id: "form-26as",
        label: "Form 26AS / AIS",
        hint: "Tax credit statement or Annual Information Statement.",
        requirement: "recommended",
        keywords: ["26as", "ais", "tis", "form26as"],
        accept: documentAccept,
      },
      {
        id: "ledger",
        label: "Ledger",
        hint: "Books of account for the incomes in question.",
        requirement: "recommended",
        keywords: ["ledger", "books", "tally", "accounts"],
        accept: `${spreadsheetAccept},.pdf`,
      },
      {
        id: "computation",
        label: "Return computation",
        hint: "Computation of income filed with the return.",
        requirement: "optional",
        keywords: ["computation", "itr", "return", "coi"],
        accept: `${documentAccept},${spreadsheetAccept}`,
      },
    ],
  },
  "msme-payment": {
    id: "msme-payment",
    title: "MSME delayed-payment dispute",
    outcome:
      "A case pack: payment reconciliation, interest under the MSMED Act, a chronology, an evidence index, and a draft claim.",
    exampleTitle: "Delayed payment claim against a buyer",
    exampleDescription:
      "Prepare a delayed-payment claim for invoices unpaid beyond 45 days, with interest under the MSMED Act and supporting evidence.",
    checklist: [
      {
        id: "invoices",
        label: "Invoices",
        hint: "Tax invoices raised on the buyer.",
        requirement: "recommended",
        keywords: ["invoice", "invoices", "bill", "bills"],
        accept: documentAccept,
      },
      {
        id: "purchase-orders",
        label: "Purchase orders or contract",
        hint: "Agreed payment terms, if any.",
        requirement: "recommended",
        keywords: ["po", "purchase", "order", "contract", "agreement"],
        accept: documentAccept,
      },
      {
        id: "statement",
        label: "Ledger or statement of account",
        hint: "Shows invoices, receipts, and the outstanding balance.",
        requirement: "recommended",
        keywords: ["ledger", "statement", "soa", "account", "accounts"],
        accept: `${spreadsheetAccept},.pdf`,
      },
      {
        id: "udyam",
        label: "Udyam registration certificate",
        hint: "Establishes MSME status on the invoice dates.",
        requirement: "recommended",
        keywords: ["udyam", "msme", "registration", "certificate"],
        accept: documentAccept,
      },
      {
        id: "correspondence",
        label: "Correspondence",
        hint: "Emails, reminders, or letters about payment.",
        requirement: "optional",
        keywords: ["email", "mail", "letter", "reminder", "correspondence"],
        accept: anyAccept,
      },
    ],
  },
};

export const useCaseOrder: UseCase[] = ["data-analysis", "tax-notice", "msme-payment"];

export const uploadAccept = anyAccept;

function fileNameWords(fileName: string): { words: string[]; extension: string } {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  return { words: stem.split(/[^a-z0-9]+/).filter(Boolean), extension };
}

export function isSupportedUploadFile(file: Pick<File, "name" | "type">): boolean {
  const { extension } = fileNameWords(file.name);
  const mimeType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    (supportedUploadExtensions as readonly string[]).includes(extension) ||
    (supportedUploadMimeTypes as readonly string[]).includes(mimeType)
  );
}

export function partitionUploadFiles(files: File[]): { supported: File[]; unsupported: File[] } {
  const supported: File[] = [];
  const unsupported: File[] = [];
  for (const file of files) {
    if (isSupportedUploadFile(file)) {
      supported.push(file);
    } else {
      unsupported.push(file);
    }
  }

  return { supported, unsupported };
}

export function matchChecklistItem(
  fileName: string,
  checklist: ChecklistItem[],
): ChecklistItem | undefined {
  const { words, extension } = fileNameWords(fileName);
  const byKeyword = checklist.find((item) =>
    item.keywords.some((keyword) =>
      words.some((word) => (keyword.length < 4 ? word === keyword : word.startsWith(keyword))),
    ),
  );
  if (byKeyword) {
    return byKeyword;
  }

  return checklist.find((item) => item.extensions?.includes(extension));
}
