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
import { responsePackSpec } from "./constants.js";
import { createPreparedTaskHandler, loadCaseDocumentsAsync } from "./context.js";
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

/**
 * Grounding citations that support a provision: an exact URL match first, then a citation from
 * the same site, then one whose supporting text mentions the provision. Grounded search often
 * returns redirect URLs the model never sees, so exact matches alone would drop real sources.
 */
export function citationsForProvision(provision: Provision, citations: readonly Citation[]) {
  const exact = citations.filter((citation) => provision.sourceUrls.includes(citation.url));

  if (exact.length > 0) {
    return exact;
  }

  const hosts = new Set(provision.sourceUrls.flatMap((url) => hostnameOf(url) ?? []));
  const sameSite = citations.filter((citation) => {
    const title = citation.title.replace(/^www\./, "").toLowerCase();

    return hosts.has(title) || hosts.has(hostnameOf(citation.url) ?? "");
  });

  if (sameSite.length > 0) {
    return sameSite;
  }

  const section = sectionNumber(provision.reference);

  return section
    ? citations.filter((citation) => citation.snippet.toLowerCase().includes(section.toLowerCase()))
    : [];
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
    return { ...base, deliverables: [responsePackSpec()] };
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
    deliverables: [responsePackSpec()],
  };
}

export interface TaxResearchHandlerOptions {
  agent?: TaxResearchAgent;
}

/** Grounded research; provisions without a supporting citation become verify-against-current-law flags. */
export function createTaxResearchTaskHandler(options: TaxResearchHandlerOptions = {}): TaskHandler {
  const agent = options.agent ?? createTaxResearchAgent();

  return createPreparedTaskHandler<Set<string>, SpecialistInput, TaxResearchOutput>(agent, {
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
      return taxResearchTaskOutput(result);
    },
  });
}
