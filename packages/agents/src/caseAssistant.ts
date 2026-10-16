import { AiNonTransientError, emptyUsage, type AiClient, type Cost } from "@evianta/ai";
import type { Evidence, Finding, ModelTier, TokenUsage } from "@evianta/core";
import type { Store } from "@evianta/store";
import { z } from "zod";

import { activeFindings } from "./record.js";
import { countMatchingTerms, truncate, uniqueTerms } from "./text.js";

export const CASE_ASSISTANT_KEY = "case-assistant";

export const NOT_SUPPORTED_MESSAGE =
  "This is not supported by the current work record. You can flag it for review instead.";

export const DEFAULT_ASSISTANT_TIER: ModelTier = "cheap";

export const caseAssistantInputSchema = z.object({
  question: z.string().min(1),
  findings: z.array(
    z.object({
      findingId: z.string(),
      summary: z.string(),
      detail: z.string().optional(),
      severity: z.string().optional(),
      figures: z
        .array(z.object({ label: z.string(), value: z.number(), unit: z.string().optional() }))
        .optional(),
      evidence: z.array(
        z.object({
          evidenceId: z.string(),
          sourceRef: z.string(),
          description: z.string(),
          excerpt: z.string().optional(),
        }),
      ),
      openQuestions: z.array(z.string()).optional(),
    }),
  ),
});

export type CaseAssistantInput = z.infer<typeof caseAssistantInputSchema>;

export const caseAssistantOutputSchema = z.object({
  supported: z.boolean(),
  answer: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
});

export type CaseAssistantOutput = z.infer<typeof caseAssistantOutputSchema>;

export const CASE_ASSISTANT_SYSTEM_PROMPT = [
  "You answer a reviewer's question about a case using only the provided findings and evidence from its work record.",
  "Do not do new arithmetic; quote figures exactly as they appear in the findings.",
  "Cite the evidenceIds and findingIds you relied on, using only ids that appear in the input.",
  "If the provided record does not answer the question, set supported to false and leave the answer short. Never guess.",
].join("\n");

export interface AskCaseRequest {
  caseId: string;
  question: string;
}

export interface AskCaseDependencies {
  store: Pick<Store, "findings" | "evidence" | "tasks">;
  ai: AiClient;
  tier?: ModelTier;
  /** Maximum findings sent to the model. */
  maxFindings?: number;
}

interface AskUsage {
  usage: TokenUsage;
  cost: Cost;
  /** Findings selected by deterministic retrieval and sent to the model. */
  retrievedFindingIds: string[];
}

export type AskCaseResult =
  | (AskUsage & {
      status: "answered";
      answer: string;
      evidenceIds: string[];
      findingIds: string[];
      evidence: Evidence[];
      modelTier: ModelTier;
    })
  | (AskUsage & {
      status: "not-supported";
      message: string;
      evidenceIds: [];
      findingIds: [];
      /** The UI can offer to turn the question into an open question for review. */
      canFlagForReview: true;
    });

export interface RetrievedFinding {
  finding: Finding;
  score: number;
}

function findingSearchFields(finding: Finding, evidenceById: ReadonlyMap<string, Evidence>) {
  const evidence = finding.evidence.map((item) => evidenceById.get(item.id) ?? item);

  return {
    summary: finding.summary,
    detail: finding.detail ?? "",
    figures: (finding.figures ?? [])
      .map((figure) => `${figure.label} ${figure.key} ${figure.value}`)
      .join(" "),
    evidence: evidence
      .map((item) => `${item.sourceRef} ${item.description} ${item.excerpt ?? ""}`)
      .join(" "),
    questions: finding.openQuestions.map((question) => question.text).join(" "),
  };
}

/** Deterministic keyword scoring over the persisted work record; no model cost. */
export function retrieveRelevantFindings(
  question: string,
  findings: readonly Finding[],
  evidence: readonly Evidence[],
  limit = 6,
): RetrievedFinding[] {
  const terms = uniqueTerms(question);

  if (terms.size === 0) {
    return [];
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  return findings
    .map((finding, index) => {
      const fields = findingSearchFields(finding, evidenceById);
      const score =
        countMatchingTerms(terms, fields.summary) * 3 +
        countMatchingTerms(terms, fields.figures) * 2 +
        countMatchingTerms(terms, fields.detail) +
        countMatchingTerms(terms, fields.evidence) +
        countMatchingTerms(terms, fields.questions);

      return { finding, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ finding, score }) => ({ finding, score }));
}

function notSupported(usage: TokenUsage, cost: Cost, retrievedFindingIds: string[]): AskCaseResult {
  return {
    status: "not-supported",
    message: NOT_SUPPORTED_MESSAGE,
    evidenceIds: [],
    findingIds: [],
    canFlagForReview: true,
    usage,
    cost,
    retrievedFindingIds,
  };
}

/**
 * Grounded Q&A over a case's work record: deterministic retrieval, then one structured call whose
 * citations are restricted to the retrieved evidence. Unsupported questions get a clear refusal.
 */
export async function askCaseAsync(
  request: AskCaseRequest,
  dependencies: AskCaseDependencies,
): Promise<AskCaseResult> {
  const question = request.question.trim();
  const { store, ai } = dependencies;
  const tier = dependencies.tier ?? DEFAULT_ASSISTANT_TIER;

  if (!question) {
    return notSupported(emptyUsage(), 0, []);
  }

  const [storedFindings, evidence, tasks] = await Promise.all([
    store.findings.getFindingsForCaseAsync(request.caseId),
    store.evidence.getEvidenceForCaseAsync(request.caseId),
    store.tasks.getTasksForCaseAsync(request.caseId),
  ]);
  const findings = activeFindings(storedFindings, tasks);
  const retrieved = retrieveRelevantFindings(
    question,
    findings,
    evidence,
    dependencies.maxFindings ?? 6,
  );
  const retrievedFindingIds = retrieved.map((entry) => entry.finding.id);

  if (retrieved.length === 0) {
    return notSupported(emptyUsage(), 0, []);
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const input: CaseAssistantInput = {
    question: truncate(question, 1000),
    findings: retrieved.map(({ finding }) => ({
      findingId: finding.id,
      summary: finding.summary,
      ...(finding.detail ? { detail: truncate(finding.detail, 800) } : {}),
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.figures
        ? {
            figures: finding.figures.map(({ label, value, unit }) => ({
              label,
              value,
              ...(unit ? { unit } : {}),
            })),
          }
        : {}),
      evidence: finding.evidence.map((item) => {
        const stored = evidenceById.get(item.id) ?? item;

        return {
          evidenceId: stored.id,
          sourceRef: stored.sourceRef,
          description: stored.description,
          ...(stored.excerpt ? { excerpt: truncate(stored.excerpt, 300) } : {}),
        };
      }),
      ...(finding.openQuestions.length > 0
        ? { openQuestions: finding.openQuestions.map((item) => item.text) }
        : {}),
    })),
  };
  let result;

  try {
    result = await ai.runStructuredAsync({
      tier,
      key: CASE_ASSISTANT_KEY,
      inputSchema: caseAssistantInputSchema,
      outputSchema: caseAssistantOutputSchema,
      system: CASE_ASSISTANT_SYSTEM_PROMPT,
      input,
      maxOutputTokens: 1024,
      temperature: 0,
    });
  } catch (error) {
    if (error instanceof AiNonTransientError && error.reason === "blocked") {
      return notSupported(error.usage, error.cost, retrievedFindingIds);
    }

    throw error;
  }

  const output = result.output;
  const answer = output.answer.trim();

  if (!output.supported || !answer) {
    return notSupported(result.usage, result.cost, retrievedFindingIds);
  }

  const retrievedFindings = new Map(retrieved.map(({ finding }) => [finding.id, finding]));
  const allowedEvidenceIds = new Set(
    retrieved.flatMap(({ finding }) => finding.evidence.map((item) => item.id)),
  );
  const findingIds = [...new Set(output.findingIds)].filter((id) => retrievedFindings.has(id));
  let evidenceIds = [...new Set(output.evidenceIds)].filter((id) => allowedEvidenceIds.has(id));

  if (evidenceIds.length === 0) {
    evidenceIds = [
      ...new Set(
        findingIds.flatMap(
          (id) => retrievedFindings.get(id)?.evidence.map((item) => item.id) ?? [],
        ),
      ),
    ];
  }

  if (evidenceIds.length === 0 && findingIds.length === 0) {
    return notSupported(result.usage, result.cost, retrievedFindingIds);
  }

  const citedFindingIds =
    findingIds.length > 0
      ? findingIds
      : retrieved
          .filter(({ finding }) => finding.evidence.some((item) => evidenceIds.includes(item.id)))
          .map(({ finding }) => finding.id);

  return {
    status: "answered",
    answer,
    evidenceIds,
    findingIds: citedFindingIds,
    evidence: evidenceIds.map(
      (id) =>
        evidenceById.get(id) ??
        (retrieved
          .flatMap(({ finding }) => finding.evidence)
          .find((item) => item.id === id) as Evidence),
    ),
    modelTier: result.tier,
    usage: result.usage,
    cost: result.cost,
    retrievedFindingIds,
  };
}
