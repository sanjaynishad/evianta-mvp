import type { UseCase } from "@evianta/core";
import { normalizeQuestion, suggestedQuestions } from "@/lib/ask";

export interface CannedAnswer {
  answer: string;
  findingIds: string[];
  evidenceIds: string[];
}

// Answers written from the sample work record so fixture mode can demonstrate grounded Q&A
// without a model. Questions outside this list fall back to keyword retrieval.
const cannedAnswers: Record<UseCase, CannedAnswer[]> = {
  "tax-notice": [
    {
      answer:
        "The intimation allows TDS of 1,86,600 against 1,99,000 claimed, a gap of 12,400. The reconciliation traces the whole gap to receipts from Mehta Exports: the ledger shows 12,400 of TDS on those receipts, but Form 26AS lists no credit from that deductor, and the client's note suggests the TDS certificate carries a PAN that differs by one character.",
      findingIds: ["b-finding-issue", "b-finding-mismatch"],
      evidenceIds: ["b-ev-notice-para", "b-ev-ledger-rows", "b-ev-26as-page", "b-ev-client-note"],
    },
    {
      answer:
        "The research points to section 199 read with Rule 37BA, which allow credit for tax deducted and paid to the Government. Once the deductor files a correction statement, the response can ask for rectification under section 154. The record flags this as needing verification against the law in force for AY 2025-26.",
      findingIds: ["b-finding-provision"],
      evidenceIds: ["b-ev-research"],
    },
    {
      answer:
        "The draft asks the department to allow the 12,400 credit on rectification under section 154 after Mehta Exports files a corrected TDS statement, enclosing Form 16A and the ledger extract as support.",
      findingIds: ["b-finding-mismatch", "b-finding-provision"],
      evidenceIds: ["b-ev-ledger-rows", "b-ev-research"],
    },
  ],
  "msme-payment": [
    {
      answer:
        "Four invoices remain unpaid beyond 45 days: KF-2025-104, 107, 111, and 115, totalling 8,42,000. They are between 63 and 148 days past acceptance; part payments were applied to older invoices first.",
      findingIds: ["c-finding-overdue"],
      evidenceIds: ["c-ev-statement-rows", "c-ev-invoice-104"],
    },
    {
      answer:
        "Interest of 61,870 is compound interest with monthly rests at three times the RBI bank rate, running from the 46th day after acceptance to 2 Oct 2026, using the invoice amounts and acceptance dates in the statement of account.",
      findingIds: ["c-finding-interest"],
      evidenceIds: ["c-ev-statement-rows-interest"],
    },
    {
      answer:
        "Yes. Kaveri Fabricators was registered as a micro enterprise on 14 Mar 2023, before the first unpaid invoice.",
      findingIds: ["c-finding-udyam"],
      evidenceIds: ["c-ev-udyam"],
    },
  ],
  "data-analysis": [
    {
      answer:
        "Returns in West reached 9.2% of gross sales in August against about 4% in other months. Most of the value comes from return notes RTN-0812 to RTN-0868 from Deccan Distributors, Pune.",
      findingIds: ["a-finding-west-returns"],
      evidenceIds: ["a-ev-west-returns"],
    },
    {
      answer:
        "Net sales grew 18.3% from July to September, from 42.1 lakh to 49.8 lakh, with every region contributing.",
      findingIds: ["a-finding-growth"],
      evidenceIds: ["a-ev-monthly-totals"],
    },
    {
      answer:
        "142 rows have no customer region. They total 9.45 lakh of net sales and are grouped as Unassigned in the regional view.",
      findingIds: ["a-finding-missing-region"],
      evidenceIds: ["a-ev-missing-region"],
    },
  ],
};

export function findCannedAnswer(useCase: UseCase, question: string): CannedAnswer | undefined {
  const normalized = normalizeQuestion(question);
  const index = suggestedQuestions[useCase].findIndex(
    (candidate) => normalizeQuestion(candidate) === normalized,
  );
  return index >= 0 ? cannedAnswers[useCase][index] : undefined;
}
