import { VERIFY_AGAINST_CURRENT_LAW } from "@evianta/ai";
import type { Citation } from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent, type AgentResult } from "../../agent.js";
import {
  SPECIALIST_DEFINITIONS,
  specialistInputSchema,
  type SpecialistInput,
} from "../../agents/specialist.js";
import {
  agentFindingSchema,
  specialistOutputSchema,
  type AgentFindingInput,
  type OpenQuestionDraft,
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskHandler,
  type TaskOutput,
} from "../../handlers.js";
import { taxNoticePackSpec } from "./constants.js";
import { createPreparedTaskHandler, loadCaseDocumentsAsync, resolveTaskAgent } from "./context.js";
import { readTaxRecords, taxRecordDocumentIds } from "./records.js";

export const provisionSchema = z.object({
  reference: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().min(1),
  relevance: z.string().optional(),
  sourceUrls: z.array(z.string()).default([]),
});

export type Provision = z.infer<typeof provisionSchema>;

export const taxResearchOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  summary: z.string().optional(),
  provisions: z.array(provisionSchema).default([]),
});

export type TaxResearchOutput = z.infer<typeof taxResearchOutputSchema>;

export type TaxResearchAgent = Agent<SpecialistInput, TaxResearchOutput>;

export const TAX_RESEARCH_SYSTEM_PROMPT = [
  "You are the tax researcher preparing an income-tax notice response for a Chartered Accountant to review.",
  "Use Google Search to find the provisions of the Income-tax Act, rules, CBDT circulars, and official guidance that may apply to the issues in priorFindings (the notice analysis and the reconciliation).",
  "Return each provision in provisions with its reference (for example a section and clause), a short title, a neutral summary of what it says, why it may be relevant to this notice, and the URLs of the sources you relied on in sourceUrls. Prefer official sources such as incometaxindia.gov.in and the e-filing portal.",
  "Only state what a source supports. If you could not find a source for a provision, still list it with empty sourceUrls so it is flagged for verification.",
  "This is research for a professional, not advice: do not conclude how the law applies or what the outcome will be. Put a short overview in summary.",
].join("\n");

export function createTaxResearchAgent(): TaxResearchAgent {
  const { profile } = SPECIALIST_DEFINITIONS["tax-research"];

  return defineAgent<SpecialistInput, TaxResearchOutput>({
    role: "tax-research",
    modelTier: profile.modelTier,
    systemPrompt: TAX_RESEARCH_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: taxResearchOutputSchema,
    grounding: true,
    maxOutputTokens: 4096,
    profile,
  });
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function sectionNumber(reference: string): string | undefined {
  return /\b(\d{1,3}[A-Z]{0,3})(\(\w+\))*/i.exec(reference)?.[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// How each kind of provision is written before its number, for example "u/s 143" or "r. 37BA".
const PROVISION_KINDS: ReadonlyArray<{ kind: string; pattern: RegExp; prefix: string }> = [
  {
    kind: "section",
    pattern: /\b(section|sec)\b|\bu\/s\b/i,
    prefix: "(?:sections?|sec\\.?|u\\/s|s\\.)",
  },
  { kind: "rule", pattern: /\brules?\b/i, prefix: "(?:rules?|r\\.)" },
  { kind: "circular", pattern: /\bcircular\b/i, prefix: "(?:circular(?:\\s+no\\.?)?)" },
  { kind: "notification", pattern: /\bnotification\b/i, prefix: "(?:notification(?:\\s+no\\.?)?)" },
];

export function provisionKind(reference: string): string | undefined {
  return PROVISION_KINDS.find((entry) => entry.pattern.test(reference))?.kind;
}

/**
 * True when the text names the complete identifier, so "80C" does not match "80CCC". With a
 * kind, the number must follow that kind's word, so "Rule 37" does not match "Section 37".
 */
export function mentionsProvision(text: string, identifier: string, kind?: string): boolean {
  const prefix = PROVISION_KINDS.find((entry) => entry.kind === kind)?.prefix;
  const number = `${escapeRegExp(identifier)}(?!\\w)`;
  const pattern = prefix ? `\\b${prefix}\\s*${number}` : `(?<![\\w(])${number}`;

  return new RegExp(pattern, "i").test(text);
}

/**
 * Grounding citations that support a provision: exact URL matches first. Grounded search often
 * returns redirect URLs the model never sees, so otherwise a citation counts only when its title
 * or supporting text names the provision's complete identifier, preferring the cited site.
 */
export function citationsForProvision(provision: Provision, citations: readonly Citation[]) {
  const exact = citations.filter((citation) => provision.sourceUrls.includes(citation.url));

  if (exact.length > 0) {
    return exact;
  }

  const identifier = sectionNumber(provision.reference);

  if (!identifier) {
    return [];
  }

  const hosts = new Set(provision.sourceUrls.flatMap((url) => hostnameOf(url) ?? []));
  const sameSite = citations.filter((citation) => {
    const title = citation.title.replace(/^www\./, "").toLowerCase();

    return hosts.has(title) || hosts.has(hostnameOf(citation.url) ?? "");
  });
  const candidates = sameSite.length > 0 ? sameSite : citations;

  const kind = provisionKind(provision.reference);

  return candidates.filter((citation) =>
    mentionsProvision(`${citation.title} ${citation.snippet}`, identifier, kind),
  );
}

export function verifyFlag(provision: Provision): OpenQuestionDraft {
  return {
    text: `${VERIFY_AGAINST_CURRENT_LAW}: "${provision.reference}" is not supported by a cited source in the research. Confirm the provision and its current text before relying on it.`,
    severity: "high",
  };
}

export function provisionFindings(
  provisions: readonly Provision[],
  citations: readonly Citation[],
): { findings: AgentFindingInput[]; supported: Map<string, Citation[]> } {
  const supported = new Map<string, Citation[]>();
  const findings = provisions.map((provision): AgentFindingInput => {
    const sources = citationsForProvision(provision, citations);
    const title = provision.title
      ? `${provision.reference}: ${provision.title}`
      : provision.reference;
    const detail = [
      provision.summary,
      provision.relevance ? `Relevance: ${provision.relevance}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    supported.set(provision.reference, sources);

    if (sources.length === 0) {
      return {
        summary: `${title} (unverified)`,
        detail,
        severity: "low",
        confidence: "low",
        evidence: [],
        openQuestions: [verifyFlag(provision)],
      };
    }

    return {
      summary: title,
      detail,
      severity: "medium",
      confidence: "medium",
      evidence: sources.map((citation) => ({
        url: citation.url,
        description: citation.title,
      })),
      assumptions: [
        `${VERIFY_AGAINST_CURRENT_LAW}: confirm that ${provision.reference} is current and applies to this assessment year.`,
      ],
    };
  });

  return { findings, supported };
}

function researchMarkdown(
  output: TaxResearchOutput,
  supported: ReadonlyMap<string, Citation[]>,
  citations: readonly Citation[],
): string {
  const numbered = new Map(citations.map((citation, index) => [citation.url, index + 1]));
  const parts = [output.summary?.trim() || "Potentially applicable provisions, with sources."];

  for (const provision of output.provisions) {
    const sources = supported.get(provision.reference) ?? [];
    const markers = sources.map((citation) => `[${numbered.get(citation.url)}]`).join("");
    const heading = provision.title
      ? `${provision.reference}: ${provision.title}`
      : provision.reference;

    parts.push(
      "",
      `**${heading}** ${markers || `(${VERIFY_AGAINST_CURRENT_LAW.toLowerCase()}: no cited source)`}`.trim(),
      provision.summary,
      ...(provision.relevance ? [`Relevance: ${provision.relevance}`] : []),
    );
  }

  if (citations.length > 0) {
    parts.push(
      "",
      "**Sources**",
      ...citations.map((citation, index) => `${index + 1}. ${citation.title}: ${citation.url}`),
    );
  }

  parts.push(
    "",
    `${VERIFY_AGAINST_CURRENT_LAW} before relying on any provision above. This research is not a legal determination.`,
  );

  return parts.join("\n");
}

export function taxResearchTaskOutput(result: AgentResult<TaxResearchOutput>): TaskOutput {
  const base = specialistResultToTaskOutput(result, true);

  if (result.output.provisions.length === 0) {
    return { ...base, deliverables: [taxNoticePackSpec()] };
  }

  const citations = result.citations;
  const { findings, supported } = provisionFindings(result.output.provisions, citations);
  const allFindings = [...findings, ...base.findings];

  return {
    ...base,
    findings: allFindings,
    sections: [
      {
        title: "Research: potentially applicable provisions",
        kind: "text",
        content: researchMarkdown(result.output, supported, citations),
        findingIndexes: allFindings.map((_finding, index) => index),
      },
    ],
    deliverables: [taxNoticePackSpec()],
  };
}

export interface TaxResearchHandlerOptions {
  agent?: TaxResearchAgent;
}

/** Grounded research; provisions without a supporting citation become verify-against-current-law flags. */
export function createTaxResearchTaskHandler(options: TaxResearchHandlerOptions = {}): TaskHandler {
  return createPreparedTaskHandler<Set<string>, SpecialistInput, TaxResearchOutput>(
    "tax-research",
    (ctx) => resolveTaskAgent(ctx, "tax-research", options.agent, createTaxResearchAgent),
    {
      async prepareAsync(ctx) {
        return taxRecordDocumentIds(readTaxRecords(await loadCaseDocumentsAsync(ctx)));
      },
      buildInput(ctx, recordDocumentIds) {
        const input = buildSpecialistInput(ctx);

        return {
          ...input,
          documents: input.documents.filter(
            (slice) => !(slice.kind === "table" && recordDocumentIds.has(slice.documentId)),
          ),
        };
      },
      toTaskOutput(result) {
        return taxResearchTaskOutput({
          ...result,
          output: taxResearchOutputSchema.parse(result.output),
        });
      },
    },
  );
}
