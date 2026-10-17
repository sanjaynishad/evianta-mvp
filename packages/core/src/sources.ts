import { z } from "zod";

export const sourceConnectorIdSchema = z.enum([
  "tally",
  "busy",
  "zoho-books",
  "shopify",
  "gmail",
  "outlook",
  "google-drive",
]);

export type SourceConnectorId = z.infer<typeof sourceConnectorIdSchema>;

export const sourceCategorySchema = z.enum(["accounting", "commerce", "email", "files"]);

export type SourceCategory = z.infer<typeof sourceCategorySchema>;

export const sourceDatasetSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  // Checklist item ids (from the use-case catalog) this dataset can fill.
  satisfies: z.array(z.string()).default([]),
});

export type SourceDataset = z.infer<typeof sourceDatasetSchema>;

export const sourceConnectorDefinitionSchema = z.object({
  id: sourceConnectorIdSchema,
  name: z.string(),
  category: sourceCategorySchema,
  monogram: z.string().min(1).max(2),
  provides: z.string(),
  scopes: z.array(z.string()).default([]),
  // Every connector is a demo today: connecting is simulated and imports return synthetic data.
  mode: z.literal("demo").default("demo"),
  datasets: z.array(sourceDatasetSchema).default([]),
});

export type SourceConnectorDefinition = z.infer<typeof sourceConnectorDefinitionSchema>;

export const sourceConnectionStatusSchema = z.enum(["connected"]);

export const sourceConnectionSchema = z.object({
  id: z.string(),
  visitorId: z.string(),
  connectorId: sourceConnectorIdSchema,
  accountLabel: z.string(),
  status: sourceConnectionStatusSchema.default("connected"),
  connectedAt: z.string(),
  lastImportAt: z.string().optional(),
});

export type SourceConnection = z.infer<typeof sourceConnectionSchema>;

export type SourceConnectionInput = z.input<typeof sourceConnectionSchema>;

// One importable item inside a connected source, such as a ledger export or an email thread.
export const sourceItemSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string(),
  connectorId: sourceConnectorIdSchema,
  datasetId: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  satisfies: z.array(z.string()).default([]),
});

export type SourceItem = z.infer<typeof sourceItemSchema>;

// Where an imported document came from; shown as evidence metadata on the output side.
export const documentProvenanceSchema = z.object({
  connectorId: sourceConnectorIdSchema,
  connectionId: z.string(),
  itemId: z.string(),
  label: z.string().optional(),
});

export type DocumentProvenance = z.infer<typeof documentProvenanceSchema>;

export const sourceConnectorCatalog: readonly SourceConnectorDefinition[] = [
  {
    id: "tally",
    name: "Tally",
    category: "accounting",
    monogram: "T",
    provides: "Ledgers, outstanding receivables, and sales registers",
    scopes: ["Read ledgers and vouchers", "Read outstanding reports"],
    mode: "demo",
    datasets: [
      {
        id: "party-ledger",
        label: "Party ledger",
        description: "Ledger account for a customer or income head, with receipts and balance.",
        satisfies: ["ledger", "statement"],
      },
      {
        id: "outstanding-receivables",
        label: "Outstanding receivables",
        description: "Bill-wise outstanding amounts with due dates and days overdue.",
        satisfies: ["statement"],
      },
      {
        id: "sales-register",
        label: "Sales register",
        description: "Invoice-level sales with date, party, region, item, and amount.",
        satisfies: ["sales-data"],
      },
    ],
  },
  {
    id: "busy",
    name: "Busy",
    category: "accounting",
    monogram: "B",
    provides: "Ledgers and sales registers",
    scopes: ["Read ledgers", "Read sales registers"],
    mode: "demo",
    datasets: [
      {
        id: "ledger",
        label: "Ledger",
        description: "Ledger account with vouchers and running balance.",
        satisfies: ["ledger", "statement"],
      },
      {
        id: "sales-register",
        label: "Sales register",
        description: "Invoice-level sales with date, party, item, and amount.",
        satisfies: ["sales-data"],
      },
    ],
  },
  {
    id: "zoho-books",
    name: "Zoho Books",
    category: "accounting",
    monogram: "Z",
    provides: "Invoices, customer statements, items, and budgets",
    scopes: ["Read invoices", "Read customer statements", "Read items and budgets"],
    mode: "demo",
    datasets: [
      {
        id: "invoices",
        label: "Invoices",
        description: "Tax invoices raised on a customer.",
        satisfies: ["invoices"],
      },
      {
        id: "customer-statement",
        label: "Customer statement",
        description: "Statement of account with invoices, payments, and balance.",
        satisfies: ["statement"],
      },
      {
        id: "items",
        label: "Items",
        description: "Product list with category and price.",
        satisfies: ["master-data"],
      },
      {
        id: "budget",
        label: "Budget",
        description: "Monthly sales budget by region.",
        satisfies: ["targets"],
      },
    ],
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "commerce",
    monogram: "S",
    provides: "Orders and products",
    scopes: ["Read orders", "Read products"],
    mode: "demo",
    datasets: [
      {
        id: "orders",
        label: "Orders",
        description: "Order lines with date, region, product, quantity, and amount.",
        satisfies: ["sales-data"],
      },
      {
        id: "products",
        label: "Products",
        description: "Product catalogue with category and price.",
        satisfies: ["master-data"],
      },
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    category: "email",
    monogram: "G",
    provides: "Email threads such as payment reminders and tax intimations",
    scopes: ["Read messages that match your search"],
    mode: "demo",
    datasets: [
      {
        id: "payment-reminders",
        label: "Payment reminders",
        description: "Reminder emails sent to the buyer about unpaid invoices.",
        satisfies: ["correspondence"],
      },
      {
        id: "tax-intimation",
        label: "Income-tax intimation",
        description: "Intimation email from the Centralized Processing Centre.",
        satisfies: ["notice"],
      },
    ],
  },
  {
    id: "outlook",
    name: "Outlook",
    category: "email",
    monogram: "O",
    provides: "Email threads such as purchase orders and buyer correspondence",
    scopes: ["Read messages that match your search"],
    mode: "demo",
    datasets: [
      {
        id: "buyer-correspondence",
        label: "Buyer correspondence",
        description: "Email thread with the buyer about delivery and payment.",
        satisfies: ["correspondence"],
      },
      {
        id: "purchase-order",
        label: "Purchase order email",
        description: "Purchase order received from the buyer, with payment terms.",
        satisfies: ["purchase-orders"],
      },
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "files",
    monogram: "D",
    provides: "Files and Sheets such as Form 26AS, certificates, and targets",
    scopes: ["Read files you pick"],
    mode: "demo",
    datasets: [
      {
        id: "form-26as",
        label: "Form 26AS",
        description: "Annual tax credit statement.",
        satisfies: ["form-26as"],
      },
      {
        id: "computation",
        label: "Computation of income",
        description: "Computation filed with the return.",
        satisfies: ["computation"],
      },
      {
        id: "udyam-certificate",
        label: "Udyam certificate",
        description: "Udyam registration certificate.",
        satisfies: ["udyam"],
      },
      {
        id: "sales-targets",
        label: "Sales targets sheet",
        description: "Monthly targets by region.",
        satisfies: ["targets"],
      },
    ],
  },
];

export const sourceCategoryLabels: Record<SourceCategory, string> = {
  accounting: "Accounting",
  commerce: "Commerce",
  email: "Email",
  files: "Files",
};

export function findSourceConnector(
  connectorId: SourceConnectorId,
): SourceConnectorDefinition | undefined {
  return sourceConnectorCatalog.find((connector) => connector.id === connectorId);
}

export function sourceConnectorsForChecklistItem(itemId: string): SourceConnectorDefinition[] {
  return sourceConnectorCatalog.filter((connector) =>
    connector.datasets.some((dataset) => dataset.satisfies.includes(itemId)),
  );
}
