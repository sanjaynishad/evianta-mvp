import {
  agentProfileSchema,
  agentRoleSchema,
  findingDateSchema,
  findingFigureSchema,
  findingSeveritySchema,
  openQuestionSeveritySchema,
  openQuestionStatusSchema,
  useCaseSchema,
  type AgentProfile,
  type AgentRole,
  type ModelTier,
} from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent } from "../agent.js";
import { specialistOutputSchema, type SpecialistOutput } from "../findings.js";

export const SPECIALIST_ROLES = [
  "business-data-analyst",
  "case-analysis",
  "reconciliation",
  "tax-research",
  "response-preparation",
  "document-analysis",
  "payment-reconciliation",
  "evidence-analysis",
  "legal-research",
  "case-preparation",
] as const satisfies readonly AgentRole[];

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export function isSpecialistRole(role: AgentRole): role is SpecialistRole {
  return (SPECIALIST_ROLES as readonly AgentRole[]).includes(role);
}

export const documentSliceSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  kind: z.enum(["page", "table"]),
  page: z.number().int().positive().optional(),
  sheet: z.string().optional(),
  table: z.string().optional(),
  range: z.string().optional(),
  rowRange: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  method: z.string().optional(),
  truncated: z.boolean(),
});

export const priorFindingSchema = z.object({
  findingId: z.string(),
  taskTitle: z.string(),
  role: agentRoleSchema,
  summary: z.string(),
  detail: z.string().optional(),
  severity: findingSeveritySchema.optional(),
  figures: z.array(findingFigureSchema).optional(),
  dates: z.array(findingDateSchema).optional(),
  openQuestions: z
    .array(
      z.object({
        text: z.string(),
        severity: openQuestionSeveritySchema,
        status: openQuestionStatusSchema,
        resolutionNote: z.string().optional(),
      }),
    )
    .optional(),
  evidence: z
    .array(
      z.object({
        evidenceId: z.string(),
        sourceRef: z.string(),
        documentId: z.string().optional(),
        textQuote: z.string().optional(),
      }),
    )
    .default([]),
});

export type PriorFinding = z.infer<typeof priorFindingSchema>;

export const specialistInputSchema = z.object({
  role: agentRoleSchema,
  case: z.object({
    title: z.string(),
    description: z.string().optional(),
    useCase: useCaseSchema.optional(),
  }),
  task: z.object({
    title: z.string(),
    instructions: z.string().optional(),
  }),
  priorFindings: z.array(priorFindingSchema).default([]),
  documents: z.array(documentSliceSchema).default([]),
  /** Deterministic pre-step results supplied by a task handler, for example computed metrics. */
  context: z.record(z.unknown()).optional(),
});

export type SpecialistInput = z.infer<typeof specialistInputSchema>;

export type SpecialistAgent = Agent<SpecialistInput, SpecialistOutput>;

interface SpecialistDefinition {
  profile: AgentProfile;
  focus: string;
  grounding?: boolean;
}

function profile(input: z.input<typeof agentProfileSchema>): AgentProfile {
  return agentProfileSchema.parse(input);
}

const PREPARATION_ONLY = "Prepares material for professional review; takes no external action.";

export const SPECIALIST_DEFINITIONS: Readonly<Record<SpecialistRole, SpecialistDefinition>> = {
  "business-data-analyst": {
    focus:
      "Interpret the deterministic metrics and data-quality results you are given: explain trends, flag anomalies and data-quality issues, and list assumptions and open questions.",
    profile: profile({
      role: "business-data-analyst",
      displayName: "Business Data Analyst",
      specialty: "Sales and operational data analysis",
      summary:
        "Turns spreadsheets into metrics, trends, anomalies, and a dashboard, with every claim traced to the data.",
      capabilities: [
        "Key metrics, trends, and period-over-period changes",
        "Anomaly and data-quality detection",
        "Dashboard chart specifications",
      ],
      tools: ["deterministic metrics", "data-quality checks"],
      procedures: [
        "Compute metrics deterministically before interpretation",
        "Link each material claim to columns, aggregates, or row ranges",
      ],
      outputFormats: ["report", "dashboard"],
      limitations: ["Does not perform arithmetic itself; relies on computed metrics"],
      modelTier: "mid",
    }),
  },
  "case-analysis": {
    focus:
      "Extract the notice's issues, dates, demanded figures, deadlines, and requested information. Flag low-confidence or illegible content.",
    profile: profile({
      role: "case-analysis",
      displayName: "Case Analyst",
      specialty: "Income-tax notice analysis",
      summary:
        "Reads the notice and records the issues raised, key dates, demanded figures, and what is being asked for.",
      capabilities: ["Issue and deadline extraction", "Demand figure capture"],
      tools: ["document extraction"],
      procedures: ["Quote the notice for every extracted figure and date"],
      outputFormats: ["structured findings"],
      limitations: [PREPARATION_ONLY, "Flags low-confidence OCR rather than guessing"],
      modelTier: "cheap",
    }),
  },
  reconciliation: {
    focus:
      "Compare return figures, ledgers, and tax-credit records and explain each discrepancy. State totals with their components so they can be recomputed.",
    profile: profile({
      role: "reconciliation",
      displayName: "Reconciliation Specialist",
      specialty: "Return, ledger, and tax-credit reconciliation",
      summary:
        "Matches return figures against ledgers and 26AS/AIS style records and explains each difference.",
      capabilities: ["Matched and unmatched item lists", "Discrepancy explanation"],
      tools: ["deterministic reconciliation"],
      procedures: ["Cite source rows for every discrepancy", "Show totals with components"],
      outputFormats: ["reconciliation table", "structured findings"],
      limitations: [PREPARATION_ONLY],
      modelTier: "mid",
    }),
  },
  "tax-research": {
    grounding: true,
    focus:
      "Research potentially applicable provisions and references. Cite sources by URL and flag anything that must be verified against current law.",
    profile: profile({
      role: "tax-research",
      displayName: "Tax Researcher",
      specialty: "Income-tax provisions and references",
      summary:
        "Finds potentially applicable provisions with cited sources and flags items to verify against current law.",
      capabilities: ["Provision research", "Source citation"],
      tools: ["google-search-grounding"],
      procedures: ["Cite every claim", "Flag unverifiable claims for verification"],
      outputFormats: ["research memo", "structured findings"],
      limitations: [PREPARATION_ONLY, "Not legal advice; verify against current law"],
      modelTier: "mid",
    }),
  },
  "response-preparation": {
    focus:
      "Draft the response for the professional, referencing the findings and schedules it relies on. Do not introduce new figures.",
    profile: profile({
      role: "response-preparation",
      displayName: "Response Drafter",
      specialty: "Notice response drafting",
      summary:
        "Drafts the notice response and assembles supporting calculations and schedules for CA review.",
      capabilities: ["Response drafting", "Schedule assembly"],
      tools: [],
      procedures: ["Reference prior findings for every figure"],
      outputFormats: ["document"],
      limitations: [PREPARATION_ONLY, "Never files or submits anything"],
      modelTier: "mid",
    }),
  },
  "document-analysis": {
    focus:
      "Organize purchase orders, agreements, invoices, delivery records, and correspondence, and extract their key fields (numbers, dates, amounts, parties).",
    profile: profile({
      role: "document-analysis",
      displayName: "Document Analyst",
      specialty: "Commercial document organization",
      summary:
        "Organizes the document set and extracts key fields from invoices, orders, agreements, and correspondence.",
      capabilities: ["Document classification", "Key field extraction"],
      tools: ["document extraction"],
      procedures: ["Quote the source for every extracted field"],
      outputFormats: ["structured findings"],
      limitations: [PREPARATION_ONLY, "Flags low-confidence OCR rather than guessing"],
      modelTier: "cheap",
    }),
  },
  "payment-reconciliation": {
    focus:
      "Compare invoices with payment records and explain the outstanding amount. State totals with their components so they can be recomputed.",
    profile: profile({
      role: "payment-reconciliation",
      displayName: "Payment Reconciliation Specialist",
      specialty: "Invoice and payment reconciliation",
      summary:
        "Matches invoices with payments and explains the outstanding amount from confirmed records.",
      capabilities: ["Invoice to payment matching", "Outstanding amount explanation"],
      tools: ["deterministic reconciliation"],
      procedures: ["Trace the outstanding amount to invoices and payments"],
      outputFormats: ["reconciliation table", "structured findings"],
      limitations: [PREPARATION_ONLY],
      modelTier: "mid",
    }),
  },
  "evidence-analysis": {
    focus:
      "Build a dated chronology linked to source documents and identify missing documents, inconsistencies, and disputed items.",
    profile: profile({
      role: "evidence-analysis",
      displayName: "Evidence Analyst",
      specialty: "Chronology and evidence gaps",
      summary:
        "Builds the evidence chronology and identifies missing documents, inconsistencies, and disputed items.",
      capabilities: ["Chronology building", "Gap and inconsistency detection"],
      tools: [],
      procedures: ["Link every event to its source document"],
      outputFormats: ["timeline", "structured findings"],
      limitations: [PREPARATION_ONLY],
      modelTier: "mid",
    }),
  },
  "legal-research": {
    grounding: true,
    focus:
      "Identify potentially relevant contractual and statutory routes. Cite sources by URL and flag items for professional verification.",
    profile: profile({
      role: "legal-research",
      displayName: "Legal Researcher",
      specialty: "Delayed-payment remedies",
      summary:
        "Identifies potentially relevant contractual and statutory routes with cited sources and verification flags.",
      capabilities: ["Statutory route research", "Source citation"],
      tools: ["google-search-grounding"],
      procedures: ["Cite every claim", "Flag items for professional verification"],
      outputFormats: ["research memo", "structured findings"],
      limitations: [PREPARATION_ONLY, "Not legal advice; verify against current law"],
      modelTier: "mid",
    }),
  },
  "case-preparation": {
    focus:
      "Assemble the case pack from prior findings and draft a proposed follow-up or escalation. Do not introduce new figures.",
    profile: profile({
      role: "case-preparation",
      displayName: "Case Preparer",
      specialty: "Case pack assembly",
      summary:
        "Assembles findings and evidence into a case pack with a proposed follow-up or escalation draft.",
      capabilities: ["Case pack assembly", "Follow-up drafting"],
      tools: [],
      procedures: ["Reference prior findings for every figure"],
      outputFormats: ["document"],
      limitations: [PREPARATION_ONLY, "Never sends or escalates anything"],
      modelTier: "mid",
    }),
  },
};

export function specialistSystemPrompt(role: AgentRole, focus: string, grounding: boolean): string {
  const citation = grounding
    ? "Cite web sources with evidence entries whose url is a grounding source. Add a high-severity open question for any claim you could not source."
    : "Cite evidence with the documentId of a provided document slice plus the page, sheet, cellRange, rows, or a short verbatim textQuote. Table slices number rows and cells in worksheet coordinates from their range and rowRange.";

  return [
    `You are the ${role} specialist in a professional workspace that prepares work for human review.`,
    `Your focus: ${focus}`,
    "Use only the provided documents, prior findings, and context. Never invent documents, figures, or dates.",
    citation,
    "To rely on a source already cited by a prior finding, add an evidence entry with its evidenceId.",
    "Every material finding (severity high or medium) needs at least one evidence entry.",
    "Report figures exactly as sourced. When a figure is a total or a difference, list its components (negative values for deductions) so it can be recomputed. Reuse the same figure key for the same quantity across findings.",
    "Record dates as ISO yyyy-mm-dd with a stable key.",
    "Put uncertainties, missing records, and low-confidence content in openQuestions with a severity.",
    "Do not make legal determinations or take any external action.",
    "Optionally return a section with a concise write-up of your work for the deliverable.",
  ].join("\n");
}

export interface SpecialistAgentOverrides {
  modelTier?: ModelTier;
  systemPrompt?: string;
}

/** A generic, role-parameterized specialist. Use-case PRs specialize prompts via overrides. */
export function createSpecialistAgent(
  role: SpecialistRole,
  overrides: SpecialistAgentOverrides = {},
): SpecialistAgent {
  const definition = SPECIALIST_DEFINITIONS[role];
  const modelTier = overrides.modelTier ?? definition.profile.modelTier;
  const grounding = definition.grounding === true;

  return defineAgent<SpecialistInput, SpecialistOutput>({
    role,
    modelTier,
    systemPrompt:
      overrides.systemPrompt ?? specialistSystemPrompt(role, definition.focus, grounding),
    inputSchema: specialistInputSchema,
    outputSchema: specialistOutputSchema,
    grounding,
    profile: { ...definition.profile, modelTier },
  });
}
