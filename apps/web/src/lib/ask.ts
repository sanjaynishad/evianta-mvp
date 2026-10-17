import type { UseCase } from "@evianta/core";

export const suggestedQuestions: Record<UseCase, string[]> = {
  "tax-notice": [
    "Why is the TDS mismatch 12,400?",
    "Which provisions support claiming the credit?",
    "What should the response ask the department to do?",
  ],
  "msme-payment": [
    "Which invoices are unpaid?",
    "How was the interest computed?",
    "Is the supplier covered by the MSMED Act?",
  ],
  "data-analysis": [
    "Why did West region returns spike in August?",
    "How much did net sales grow this quarter?",
    "What data quality problems were found?",
  ],
};

export const genericSuggestedQuestions = [
  "What are the main findings?",
  "What still needs my review?",
];

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
