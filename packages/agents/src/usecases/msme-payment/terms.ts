import type { Finding } from "@evianta/core";

import type { EvidenceReference } from "../../findings.js";
import { truncate } from "../../text.js";
import { MSME_FIGURE_KEYS } from "./constants.js";
import type { PaymentCaseDocument } from "./records.js";

export type CreditTermsBasis = "invoice" | "delivery" | "acceptance" | "receipt";

export interface CreditTermsSource {
  creditDays: number;
  basis: CreditTermsBasis;
  documentId: string;
  documentName: string;
  page: number;
  quote: string;
}

export interface CreditTerms {
  creditDays: number;
  basis: CreditTermsBasis;
  /** "document" when read verbatim from a page, "document-analysis" when taken from its finding. */
  origin: "document" | "document-analysis";
  sources: CreditTermsSource[];
  evidence: EvidenceReference[];
}

export interface CreditTermsConflict {
  creditDays: number;
  where: string;
  evidence: EvidenceReference[];
}

export interface CreditTermsResolution {
  terms?: CreditTerms;
  /** Every distinct credit period stated across the documents and the document analysis. */
  conflicts: CreditTermsConflict[];
}

const BASIS = "(?:the\\s+)?(?:date\\s+of\\s+)?(?:the\\s+)?(invoice|delivery|acceptance|receipt)";
const CREDIT_TERM_PATTERNS = [
  new RegExp(
    `\\bwithin\\s+(\\d{1,3})\\s*(?:\\([a-z\\s-]+\\)\\s*)?days?\\s+(?:of|from|after)\\s+${BASIS}`,
    "gi",
  ),
  new RegExp(
    `\\b(?:credit\\s+(?:period|days|terms)|payment\\s+terms?)\\s*(?:of|:|-)?\\s*(\\d{1,3})\\s*days?(?:\\s+(?:of|from|after)\\s+${BASIS})?`,
    "gi",
  ),
];
// Deadlines set by a letter or reminder, such as "within 15 days of receipt of this letter".
const CORRESPONDENCE_DEADLINE = /\b(this|the|our|your)\s+(letter|notice|e-?mail|reminder)\b/i;

function basisOf(value: string | undefined): CreditTermsBasis {
  const lower = value?.toLowerCase();

  return lower === "delivery" || lower === "acceptance" || lower === "receipt" ? lower : "invoice";
}

function sentenceAround(text: string, index: number, length: number): string {
  const sentenceBreak = text.lastIndexOf(". ", index);
  const start = Math.max(
    text.lastIndexOf("\n", index) + 1,
    sentenceBreak === -1 ? 0 : sentenceBreak + 2,
  );
  const nextBreak = text.slice(index + length).search(/\n|\.\s/);
  const end = nextBreak === -1 ? text.length : index + length + nextBreak + 1;

  return truncate(text.slice(start, end).trim(), 240);
}

/** Credit periods stated verbatim on document pages, such as "within 60 days of the invoice date". */
export function creditTermsInDocuments(
  documents: readonly PaymentCaseDocument[],
): CreditTermsSource[] {
  const sources: CreditTermsSource[] = [];

  for (const { metadata, extraction } of documents) {
    for (const page of extraction?.pages ?? []) {
      const seen = new Set<string>();

      for (const [patternIndex, pattern] of CREDIT_TERM_PATTERNS.entries()) {
        for (const match of page.text.matchAll(pattern)) {
          const quote = sentenceAround(page.text, match.index, match[0].length);
          const days = Number(match[1]);
          const qualifies =
            !CORRESPONDENCE_DEADLINE.test(quote) &&
            (patternIndex > 0 || /\bpay|payment|credit/i.test(quote));
          const key = `${days}|${quote}`;

          if (!qualifies || !Number.isInteger(days) || days <= 0 || seen.has(key)) {
            continue;
          }

          seen.add(key);
          sources.push({
            creditDays: days,
            basis: basisOf(match[2]),
            documentId: metadata.id,
            documentName: metadata.name,
            page: page.index,
            quote,
          });
        }
      }
    }
  }

  return sources;
}

/**
 * The agreed credit period: read verbatim from the documents first, else from the document
 * analysis finding. Conflicting periods are reported and no period is chosen.
 */
export function resolveCreditTerms(
  documents: readonly PaymentCaseDocument[],
  upstreamFindings: readonly Finding[] = [],
): CreditTermsResolution {
  const sources = creditTermsInDocuments(documents);
  // A credit period the model reported without a surviving source document is never relied on.
  const analysed = upstreamFindings
    .filter((finding) => finding.evidence.some((item) => item.documentId !== undefined))
    .flatMap((finding) =>
      (finding.figures ?? [])
        .filter((figure) => figure.key === MSME_FIGURE_KEYS.agreedCreditDays && figure.value > 0)
        .map((figure) => ({ finding, days: figure.value })),
    );
  const distinct = new Map<number, CreditTermsConflict>();

  for (const source of sources) {
    if (!distinct.has(source.creditDays)) {
      distinct.set(source.creditDays, {
        creditDays: source.creditDays,
        where: `${source.documentName} p.${source.page}`,
        evidence: [
          {
            documentId: source.documentId,
            page: source.page,
            textQuote: source.quote,
            description: `Credit period of ${source.creditDays} days`,
          },
        ],
      });
    }
  }

  for (const { finding, days } of analysed) {
    if (!distinct.has(days)) {
      distinct.set(days, {
        creditDays: days,
        where: `document analysis ("${truncate(finding.summary, 80)}")`,
        evidence: finding.evidence.slice(0, 1).map((item) => ({
          evidenceId: item.id,
          description: `Credit period of ${days} days`,
        })),
      });
    }
  }

  const conflicts = distinct.size > 1 ? [...distinct.values()] : [];

  if (conflicts.length > 0) {
    return { conflicts };
  }

  const [first] = sources;

  if (first) {
    return {
      conflicts,
      terms: {
        creditDays: first.creditDays,
        basis: first.basis,
        origin: "document",
        sources,
        evidence: sources.map((source) => ({
          documentId: source.documentId,
          page: source.page,
          textQuote: source.quote,
          description: `Agreed credit period of ${source.creditDays} days`,
        })),
      },
    };
  }

  const [fromAnalysis] = analysed;

  if (fromAnalysis) {
    return {
      conflicts,
      terms: {
        creditDays: fromAnalysis.days,
        basis: "invoice",
        origin: "document-analysis",
        sources: [],
        evidence: fromAnalysis.finding.evidence.slice(0, 3).map((item) => ({
          evidenceId: item.id,
          description: `Agreed credit period of ${fromAnalysis.days} days`,
        })),
      },
    };
  }

  return { conflicts };
}
