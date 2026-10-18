import { describe, expect, it } from "vitest";

import {
  formatEmailDate,
  formatIndianNumber,
  formatRupees,
  rupeesInWords,
  toCsv,
} from "../format.js";
import {
  apexInvoices,
  apexPayments,
  daysOverdue,
  dueDateOf,
  findApexInvoice,
  invoiceTotal,
  outstandingTotal,
  unpaidApexInvoices,
} from "./receivables.js";
import { salesRegisterLines } from "./sales.js";
import { computation, form26AsEntries, tdsEntries, totalTds } from "./tax.js";

describe("demo data", () => {
  it("keeps the buyer's account consistent", () => {
    for (const payment of apexPayments.filter((entry) =>
      entry.invoiceNumber.startsWith("SHI/26"),
    )) {
      expect(payment.amount).toBe(invoiceTotal(findApexInvoice(payment.invoiceNumber)));
    }

    expect(unpaidApexInvoices().map((invoice) => invoice.number)).toEqual([
      "SHI/26-27/052",
      "SHI/26-27/067",
      "SHI/26-27/083",
      "SHI/26-27/098",
    ]);
    expect(outstandingTotal()).toBe(876_150);
    expect(unpaidApexInvoices().map((invoice) => daysOverdue(invoice))).toEqual([86, 65, 44, 23]);
    expect(dueDateOf(findApexInvoice("SHI/26-27/014"))).toBe("2026-06-02");
  });

  it("puts every Apex invoice line in the sales register", () => {
    const apexLines = salesRegisterLines().filter((line) => line.party === "Apex Retail Pvt Ltd");

    expect(apexLines).toHaveLength(apexInvoices.flatMap((invoice) => invoice.lines).length);
  });

  it("leaves a Rs. 9,000 TDS gap that the return and ledger agree on", () => {
    const figures = computation();

    expect(totalTds(tdsEntries)).toBe(45_670);
    expect(totalTds(form26AsEntries())).toBe(36_670);
    expect(figures.tdsClaimed).toBe(45_670);
    expect(figures.totalIncome).toBe(1_888_350);
    expect(figures.totalTax).toBe(589_165);
    expect(figures.balancePayable).toBe(0);
  });
});

describe("formatting", () => {
  it("formats rupees with Indian grouping and words", () => {
    expect(formatIndianNumber(876_150)).toBe("8,76,150");
    expect(formatIndianNumber(12_345_678)).toBe("1,23,45,678");
    expect(formatIndianNumber(-449)).toBe("-449");
    expect(formatRupees(212_400)).toBe("Rs. 2,12,400");
    expect(rupeesInWords(212_400)).toBe("Rupees Two Lakh Twelve Thousand Four Hundred Only");
    expect(rupeesInWords(1_336_350)).toBe(
      "Rupees Thirteen Lakh Thirty Six Thousand Three Hundred Fifty Only",
    );
  });

  it("formats email dates in India Standard Time", () => {
    expect(formatEmailDate("2026-07-24", "10:42")).toBe("Fri, 24 Jul 2026 10:42:00 +0530");
  });

  it("quotes CSV cells that need it", () => {
    expect(toCsv(["A", "B"], [["x, y", null]])).toBe('A,B\n"x, y",\n');
  });
});
