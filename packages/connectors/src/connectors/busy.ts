import { company, productBySku } from "../data/business.js";
import { SALES_PERIOD_LABEL, lineAmount, salesRegisterLines } from "../data/sales.js";
import { FINANCIAL_YEAR, summarizeByDeductor, tdsEntries, totalTds } from "../data/tax.js";
import { createDemoConnector, CSV_MIME_TYPE, textFile, type DemoItem } from "../demo.js";
import { toCsv, type CsvCell } from "../format.js";

// Shaped like the TDS ledgers the tax-notice reconciler reads: party, section, gross, and TDS.
function tdsLedgerCsv(): string {
  let balance = 0;
  const rows: CsvCell[][] = tdsEntries.map((entry) => {
    balance += entry.tds;

    return [
      entry.date,
      entry.deductor.name,
      entry.deductor.section,
      entry.grossAmount,
      entry.tds,
      balance,
      entry.voucher,
      entry.narration,
    ];
  });
  const grossTotal = tdsEntries.reduce((sum, entry) => sum + entry.grossAmount, 0);

  rows.push([null, "Total", null, grossTotal, totalTds(tdsEntries), balance, null, null]);

  return toCsv(
    [
      "Date",
      "Party",
      "Section",
      "Gross amount",
      "TDS deducted",
      "Balance",
      "Voucher No",
      "Narration",
    ],
    rows,
  );
}

function salesRegisterCsv(): string {
  return toCsv(
    ["Date", "Bill No", "Party", "Region", "Item Name", "Item Group", "Qty", "Price", "Amount"],
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

const items: Record<string, DemoItem> = {
  ledger: {
    label: "Ledger: TDS receivable",
    detail: `FY ${FINANCIAL_YEAR}, ${tdsEntries.length} entries from ${summarizeByDeductor(tdsEntries).length} deductors`,
    fileName: "busy-ledger-tds-receivable-fy2024-25.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(tdsLedgerCsv()),
  },
  "sales-register": {
    label: `Sales register: ${SALES_PERIOD_LABEL}`,
    detail: `${company.name}, ${salesRegisterLines().length} bill lines across 4 regions`,
    fileName: "busy-sales-register-apr-sep-2026.csv",
    mimeType: CSV_MIME_TYPE,
    buildAsync: () => textFile(salesRegisterCsv()),
  },
};

export const busyConnector = createDemoConnector("busy", items);
