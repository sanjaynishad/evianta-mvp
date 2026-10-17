import { company } from "./business.js";

export const ASSESSMENT_YEAR = "2025-26";
export const FINANCIAL_YEAR = "2024-25";

export const returnFiling = {
  filedOn: "2025-09-12",
  acknowledgementNumber: "684512930120925",
  section: "139(1)",
} as const;

export const intimation = {
  date: "2026-10-02",
  responseDueBy: "2026-11-01",
  referenceNumber: "CPC/2526/A3/1048327716",
  interestUnder234C: 279,
} as const;

export interface Deductor {
  tan: string;
  name: string;
  section: string;
  nature: string;
}

export const deductors = {
  kiran: {
    tan: "PNEK07731F",
    name: "Kiran Appliances Ltd",
    section: "194C",
    nature: "job work charges",
  },
  konkan: {
    tan: "MUMK02218E",
    name: "Konkan Mercantile Bank Ltd",
    section: "194A",
    nature: "interest on fixed deposits",
  },
  greenleaf: {
    tan: "BLRG05562A",
    name: "Greenleaf Hypermarkets Pvt Ltd",
    section: "194Q",
    nature: "sale of goods above Rs. 50 lakh",
  },
} as const satisfies Record<string, Deductor>;

export interface TdsEntry {
  date: string;
  deductor: Deductor;
  grossAmount: number;
  tds: number;
  voucher: string;
  bookedOn: string;
  /** False when the deductor has not reported the deduction, so Form 26AS does not show it. */
  inForm26As: boolean;
  narration: string;
}

// Kiran Appliances deducted TDS on the Q4 job work bill but has not reported it in its TDS
// statement, which is the whole Rs. 9,000 gap between the return and Form 26AS.
export const tdsEntries: readonly TdsEntry[] = [
  {
    date: "2024-06-30",
    deductor: deductors.kiran,
    grossAmount: 360_000,
    tds: 7_200,
    voucher: "JV/24-25/031",
    bookedOn: "2024-07-29",
    inForm26As: true,
    narration: "TDS on job work bills for Q1, Form 16A received",
  },
  {
    date: "2024-09-30",
    deductor: deductors.kiran,
    grossAmount: 420_000,
    tds: 8_400,
    voucher: "JV/24-25/088",
    bookedOn: "2024-10-28",
    inForm26As: true,
    narration: "TDS on job work bills for Q2, Form 16A received",
  },
  {
    date: "2024-09-30",
    deductor: deductors.konkan,
    grossAmount: 38_500,
    tds: 3_850,
    voucher: "JV/24-25/090",
    bookedOn: "2024-10-30",
    inForm26As: true,
    narration: "TDS on FD interest for Apr to Sep 2024",
  },
  {
    date: "2024-09-30",
    deductor: deductors.greenleaf,
    grossAmount: 800_000,
    tds: 800,
    voucher: "JV/24-25/091",
    bookedOn: "2024-10-30",
    inForm26As: true,
    narration: "TDS on sales above the Rs. 50 lakh threshold, Q2",
  },
  {
    date: "2024-12-31",
    deductor: deductors.kiran,
    grossAmount: 390_000,
    tds: 7_800,
    voucher: "JV/24-25/142",
    bookedOn: "2025-01-29",
    inForm26As: true,
    narration: "TDS on job work bills for Q3, Form 16A received",
  },
  {
    date: "2024-12-31",
    deductor: deductors.greenleaf,
    grossAmount: 2_100_000,
    tds: 2_100,
    voucher: "JV/24-25/143",
    bookedOn: "2025-01-30",
    inForm26As: true,
    narration: "TDS on sales, Q3",
  },
  {
    date: "2025-03-31",
    deductor: deductors.kiran,
    grossAmount: 450_000,
    tds: 9_000,
    voucher: "JV/24-25/205",
    bookedOn: "2025-05-29",
    inForm26As: false,
    narration: "TDS on job work bills for Q4 as per payment advice, Form 16A awaited",
  },
  {
    date: "2025-03-31",
    deductor: deductors.konkan,
    grossAmount: 41_200,
    tds: 4_120,
    voucher: "JV/24-25/206",
    bookedOn: "2025-05-30",
    inForm26As: true,
    narration: "TDS on FD interest for Oct 2024 to Mar 2025",
  },
  {
    date: "2025-03-31",
    deductor: deductors.greenleaf,
    grossAmount: 2_400_000,
    tds: 2_400,
    voucher: "JV/24-25/207",
    bookedOn: "2025-05-30",
    inForm26As: true,
    narration: "TDS on sales, Q4",
  },
];

export interface DeductorSummary {
  deductor: Deductor;
  grossAmount: number;
  tds: number;
}

export function summarizeByDeductor(entries: readonly TdsEntry[]): DeductorSummary[] {
  const summaries = new Map<string, DeductorSummary>();

  for (const entry of entries) {
    const summary = summaries.get(entry.deductor.tan) ?? {
      deductor: entry.deductor,
      grossAmount: 0,
      tds: 0,
    };

    summary.grossAmount += entry.grossAmount;
    summary.tds += entry.tds;
    summaries.set(entry.deductor.tan, summary);
  }

  return [...summaries.values()];
}

export function form26AsEntries(): TdsEntry[] {
  return tdsEntries.filter((entry) => entry.inForm26As);
}

export function totalTds(entries: readonly TdsEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.tds, 0);
}

export interface AdvanceTaxChallan {
  date: string;
  bsrCode: string;
  challanNumber: string;
  amount: number;
}

export const advanceTaxChallans: readonly AdvanceTaxChallan[] = [
  { date: "2024-06-14", bsrCode: "0510308", challanNumber: "24061", amount: 82_000 },
  { date: "2024-09-13", bsrCode: "0510308", challanNumber: "24187", amount: 163_000 },
  { date: "2024-12-13", bsrCode: "0510308", challanNumber: "24311", amount: 163_000 },
  { date: "2025-03-13", bsrCode: "0510308", challanNumber: "25042", amount: 135_495 },
];

/** Computation of total income as filed. Figures are whole rupees. */
export function computation() {
  const netProfit = 1_922_050;
  const fdInterest = summarizeByDeductor(tdsEntries).find(
    (summary) => summary.deductor.tan === deductors.konkan.tan,
  )?.grossAmount;

  if (fdInterest === undefined) {
    throw new Error("The demo ledger has no FD interest.");
  }

  const bookDepreciation = 214_600;
  const taxDepreciation = 248_300;
  const businessIncome = netProfit - fdInterest + bookDepreciation - taxDepreciation;
  const grossTotalIncome = businessIncome + fdInterest;
  const totalIncome = Math.round(grossTotalIncome / 10) * 10;
  const tax = Math.round(totalIncome * 0.3);
  const cess = Math.round(tax * 0.04);
  const totalTax = tax + cess;
  const tdsClaimed = totalTds(tdsEntries);
  const advanceTax = advanceTaxChallans.reduce((sum, challan) => sum + challan.amount, 0);

  return {
    netProfit,
    fdInterest,
    bookDepreciation,
    taxDepreciation,
    businessIncome,
    grossTotalIncome,
    totalIncome,
    tax,
    cess,
    totalTax,
    tdsClaimed,
    advanceTax,
    balancePayable: totalTax - tdsClaimed - advanceTax,
  };
}

export const assessee = {
  name: company.name,
  pan: company.pan,
  status: "Firm",
} as const;
