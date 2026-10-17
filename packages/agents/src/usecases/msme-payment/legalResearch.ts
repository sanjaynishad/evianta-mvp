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
  type EvidenceReference,
  type OpenQuestionDraft,
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskHandler,
  type TaskOutput,
} from "../../handlers.js";
import { msmePaymentPackSpec } from "./constants.js";
import {
  createPreparedHandler,
  loadPaymentCaseDocumentsAsync,
  resolveAgentFor,
  withoutRecordTables,
} from "./context.js";
import { msmeDocumentSourceSchema } from "./documentAnalysis.js";
import { readPaymentRecords, recordTableKeys } from "./records.js";

export const legalRouteKindSchema = z.enum(["contractual", "statutory", "procedural"]);

export type LegalRouteKind = z.infer<typeof legalRouteKindSchema>;

export const legalRouteSchema = z.object({
  name: z.string().min(1),
  kind: legalRouteKindSchema.default("statutory"),
  reference: z.string().optional(),
  summary: z.string().min(1),
  relevance: z.string().optional(),
  /** Facts a professional must confirm before the route can be relied on. */
  conditions: z.array(z.string()).default([]),
  sourceUrls: z.array(z.string()).default([]),
  documentSources: z.array(msmeDocumentSourceSchema).default([]),
});

export type LegalRoute = z.infer<typeof legalRouteSchema>;

export const legalResearchOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  summary: z.string().optional(),
  routes: z.array(legalRouteSchema).default([]),
});

export type LegalResearchOutput = z.infer<typeof legalResearchOutputSchema>;

export type LegalResearchAgent = Agent<SpecialistInput, LegalResearchOutput>;

export const LEGAL_RESEARCH_SYSTEM_PROMPT = [
  "You are the legal researcher preparing an MSME supplier's overdue-payment case for the business owner or adviser to review.",
  "Use Google Search to identify potentially relevant routes for recovering the overdue amounts in priorFindings: contractual routes in the purchase order or agreement (for example a notice or dispute clause), statutory routes such as the delayed-payment provisions of the Micro, Small and Medium Enterprises Development Act, 2006 (buyer's liability, interest, and reference to a Micro and Small Enterprises Facilitation Council), and procedural channels such as the MSME Samadhaan portal.",
  "Return each in routes with its kind, a precise reference (for example a section number), a neutral summary of what it provides, why it may be relevant here, the conditions a professional must confirm (for example the supplier's registration, the buyer's status, and the date of acceptance), and the URLs of the sources you relied on in sourceUrls. Prefer official government sources.",
  "For a contractual route, cite the clause with documentSources (documentId, page, and a short verbatim quote) instead of a URL.",
  "Only state what a source supports. If you could not find a source for a route, still list it with empty sourceUrls so it is flagged for verification.",
  "This is research for a professional, not advice: do not conclude that a route applies, that interest is payable, or what the outcome will be. Put a short overview in summary.",
].join("\n");

export function createLegalResearchAgent(): LegalResearchAgent {
  const { profile } = SPECIALIST_DEFINITIONS["legal-research"];

  return defineAgent<SpecialistInput, LegalResearchOutput>({
    role: "legal-research",
    modelTier: profile.modelTier,
    systemPrompt: LEGAL_RESEARCH_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: legalResearchOutputSchema,
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

function sectionIdentifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:section|sec\.?|s\.)\s*(\d{1,3}[A-Z]?)\b/gi)].map(
    (match) => match[1] ?? "",
  );
}

const ROUTE_KEYWORDS: readonly RegExp[] = [
  /samadhaan/i,
  /facilitation\s+council|\bmsefc\b/i,
  /online\s+dispute\s+resolution|\bodr\b/i,
];

function mentionsSection(text: string, identifier: string): boolean {
  return new RegExp(`\\b(?:section|sec\\.?|s\\.)\\s*${identifier}(?![\\w])`, "i").test(text);
}

/**
 * Grounding citations that support a route: exact URL matches first. Grounded search often
 * returns redirect URLs, so otherwise a citation counts only when it is on a site the route cites
 * and its title or supporting text names the same section number or distinctive scheme.
 */
export function citationsForRoute(route: LegalRoute, citations: readonly Citation[]): Citation[] {
  const exact = citations.filter((citation) => route.sourceUrls.includes(citation.url));

  if (exact.length > 0) {
    return exact;
  }

  const routeText = `${route.name} ${route.reference ?? ""}`;
  const sections = sectionIdentifiers(routeText);
  const keywords = ROUTE_KEYWORDS.filter((pattern) => pattern.test(routeText));
  const hosts = new Set(route.sourceUrls.flatMap((url) => hostnameOf(url) ?? []));

  if ((sections.length === 0 && keywords.length === 0) || hosts.size === 0) {
    return [];
  }

  return citations.filter((citation) => {
    const title = citation.title.replace(/^www\./, "").toLowerCase();
    const sameSite = hosts.has(title) || hosts.has(hostnameOf(citation.url) ?? "");
    const text = `${citation.title} ${citation.snippet}`;

    return (
      sameSite &&
      (sections.some((identifier) => mentionsSection(text, identifier)) ||
        keywords.some((pattern) => pattern.test(text)))
    );
  });
}

export function routeVerifyFlag(route: LegalRoute): OpenQuestionDraft {
  return {
    text: `${VERIFY_AGAINST_CURRENT_LAW}: "${route.reference ?? route.name}" is not supported by a cited source in the research. Confirm it and its current text before relying on it.`,
    severity: "high",
  };
}

function routeTitle(route: LegalRoute): string {
  return route.reference && !route.name.includes(route.reference)
    ? `${route.name} (${route.reference})`
    : route.name;
}

function documentEvidence(route: LegalRoute): EvidenceReference[] {
  return route.documentSources.map((source) => ({
    documentId: source.documentId,
    description: route.name,
    ...(source.page !== undefined ? { page: source.page } : {}),
    ...(source.quote?.trim() ? { textQuote: source.quote.trim() } : {}),
  }));
}

export function legalRouteFindings(
  routes: readonly LegalRoute[],
  citations: readonly Citation[],
): { findings: AgentFindingInput[]; supported: Map<LegalRoute, Citation[]> } {
  const supported = new Map<LegalRoute, Citation[]>();
  const findings = routes.map((route): AgentFindingInput => {
    const sources = citationsForRoute(route, citations);
    const documents = route.kind === "contractual" ? documentEvidence(route) : [];
    const title = routeTitle(route);
    const detail = [
      route.summary,
      route.relevance ? `Relevance: ${route.relevance}` : undefined,
      route.conditions.length > 0 ? `To confirm: ${route.conditions.join("; ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const conditionQuestions: OpenQuestionDraft[] = route.conditions.map((condition) => ({
      text: `${title}: confirm ${condition.replace(/\.$/, "")}.`,
      severity: "medium",
    }));

    supported.set(route, sources);

    if (sources.length === 0 && documents.length === 0) {
      return {
        summary: `${title} (unverified)`,
        detail,
        severity: "low",
        confidence: "low",
        evidence: [],
        openQuestions: [routeVerifyFlag(route), ...conditionQuestions],
      };
    }

    return {
      summary: `Potential ${route.kind} route: ${title}`,
      detail,
      severity: "medium",
      confidence: "medium",
      evidence: [
        ...sources.map((citation) => ({ url: citation.url, description: citation.title })),
        ...documents,
      ],
      assumptions: [
        route.kind === "contractual" && sources.length === 0
          ? `Confirm that ${route.reference ?? route.name} is the agreed wording in force and applies to these facts.`
          : `${VERIFY_AGAINST_CURRENT_LAW}: confirm that ${route.reference ?? route.name} is current and applies to these facts.`,
      ],
      openQuestions: conditionQuestions,
    };
  });

  return { findings, supported };
}

function researchMarkdown(
  output: LegalResearchOutput,
  supported: ReadonlyMap<LegalRoute, Citation[]>,
  citations: readonly Citation[],
): string {
  const numbered = new Map(citations.map((citation, index) => [citation.url, index + 1]));
  const parts = [
    output.summary?.trim() ||
      "Potentially relevant contractual and statutory routes, with sources.",
  ];

  for (const route of output.routes) {
    const sources = supported.get(route) ?? [];
    const markers = sources.map((citation) => `[${numbered.get(citation.url)}]`).join("");
    const contractual = route.kind === "contractual" && route.documentSources.length > 0;
    const marker =
      markers ||
      (contractual
        ? "(cites the case documents)"
        : `(${VERIFY_AGAINST_CURRENT_LAW.toLowerCase()}: no cited source)`);

    parts.push(
      "",
      `**${routeTitle(route)}** ${marker}`,
      route.summary,
      ...(route.relevance ? [`Relevance: ${route.relevance}`] : []),
      ...(route.conditions.length > 0 ? [`To confirm: ${route.conditions.join("; ")}`] : []),
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
    `${VERIFY_AGAINST_CURRENT_LAW} and the specific facts before relying on any route above. This research is not a legal determination, and nothing has been sent or filed.`,
  );

  return parts.join("\n");
}

export function legalResearchTaskOutput(result: AgentResult<LegalResearchOutput>): TaskOutput {
  const base = specialistResultToTaskOutput(result, true);

  if (result.output.routes.length === 0) {
    return { ...base, deliverables: [msmePaymentPackSpec()] };
  }

  const { findings, supported } = legalRouteFindings(result.output.routes, result.citations);
  const allFindings = [...findings, ...base.findings];

  return {
    ...base,
    findings: allFindings,
    sections: [
      {
        title: "Potential contractual and statutory routes",
        kind: "text",
        content: researchMarkdown(result.output, supported, result.citations),
        findingIndexes: allFindings.map((_finding, index) => index),
      },
    ],
    deliverables: [msmePaymentPackSpec()],
  };
}

export interface LegalResearchHandlerOptions {
  agent?: LegalResearchAgent;
}

/** Grounded research; routes without a supporting citation become verification flags. */
export function createLegalResearchTaskHandler(
  options: LegalResearchHandlerOptions = {},
): TaskHandler {
  return createPreparedHandler<Set<string>, SpecialistInput, LegalResearchOutput>(
    "legal-research",
    (ctx) => resolveAgentFor(ctx, "legal-research", options.agent, createLegalResearchAgent),
    {
      async prepareAsync(ctx) {
        return recordTableKeys(readPaymentRecords(await loadPaymentCaseDocumentsAsync(ctx)));
      },
      buildInput(ctx, recordIds) {
        return withoutRecordTables(buildSpecialistInput(ctx), recordIds);
      },
      toTaskOutput(result) {
        return legalResearchTaskOutput({
          ...result,
          output: legalResearchOutputSchema.parse(result.output),
        });
      },
    },
  );
}
