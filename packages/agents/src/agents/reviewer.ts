import {
  agentProfileSchema,
  openQuestionSeveritySchema,
  useCaseSchema,
  type FindingSeverity,
  type OpenQuestionSeverity,
} from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent } from "../agent.js";
import {
  specialistOutputSchema,
  type SpecialistOutput,
  type AgentFindingInput,
} from "../findings.js";
import {
  agentContextFor,
  toPriorFindings,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
} from "../handlers.js";
import {
  runDeterministicChecks,
  type DeterministicCheckOptions,
  type VerificationReport,
} from "../verification.js";
import { priorFindingSchema } from "./specialist.js";

export const reviewInputSchema = z.object({
  case: z.object({
    title: z.string(),
    description: z.string().optional(),
    useCase: useCaseSchema.optional(),
  }),
  task: z.object({ title: z.string(), instructions: z.string().optional() }),
  findings: z.array(priorFindingSchema),
  deterministicChecks: z.object({
    passed: z.boolean(),
    issues: z.array(
      z.object({
        check: z.string(),
        severity: openQuestionSeveritySchema,
        message: z.string(),
      }),
    ),
  }),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export type ReviewAgent = Agent<ReviewInput, SpecialistOutput>;

export const reviewerProfile = agentProfileSchema.parse({
  role: "independent-review",
  displayName: "Independent Reviewer",
  specialty: "Verification and quality review",
  summary:
    "Checks the work record with deterministic arithmetic, evidence, and consistency checks, then reviews the narrative for soundness and gaps.",
  capabilities: [
    "Recomputes totals and reconciliations",
    "Confirms every material finding cites evidence",
    "Cross-checks figures and dates across tasks",
    "Narrative soundness and missing-requirement review",
  ],
  tools: ["deterministic verification checks"],
  procedures: [
    "Run deterministic checks before any model review",
    "Review only what deterministic checks cannot",
    "Turn every unresolved item into an open question with a severity",
  ],
  outputFormats: ["review notes", "open questions"],
  limitations: ["Does not approve the deliverable; a professional must approve it"],
  modelTier: "high",
});

export const REVIEWER_SYSTEM_PROMPT = [
  "You are the independent reviewer in a professional workspace. The work is prepared for human approval.",
  "Deterministic checks have already verified arithmetic, evidence presence, and figure and date consistency; their results are in deterministicChecks. Do not repeat or recompute them.",
  "Review only what they cannot: narrative soundness, missing requirements, unsupported or overstated claims, and risky wording.",
  "Return findings only for review observations, citing evidence by documentId when a finding relies on a source.",
  "Put every unresolved item in openQuestions with a severity (high when it could change the outcome).",
  "Return a short section summarizing the review for the deliverable.",
].join("\n");

export function createReviewerAgent(): ReviewAgent {
  return defineAgent<ReviewInput, SpecialistOutput>({
    role: "independent-review",
    modelTier: "high",
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    inputSchema: reviewInputSchema,
    outputSchema: specialistOutputSchema,
    profile: reviewerProfile,
  });
}

const SEVERITY_RANK: Record<OpenQuestionSeverity, number> = { high: 3, medium: 2, low: 1 };

function highestSeverity(report: VerificationReport): FindingSeverity {
  let highest: OpenQuestionSeverity | undefined;

  for (const issue of report.issues) {
    if (!highest || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[highest]) {
      highest = issue.severity;
    }
  }

  return highest ?? "info";
}

export function verificationFinding(report: VerificationReport): AgentFindingInput {
  const summary = report.passed
    ? `Deterministic checks passed for ${report.checkedFindings} finding(s) and ${report.checkedClaims} recomputed total(s).`
    : `Deterministic checks found ${report.issues.length} issue(s) that need attention.`;
  const detail = report.passed
    ? "Totals recomputed, evidence present on every material finding, and figures and dates consistent across tasks."
    : report.issues.map((issue) => `- [${issue.check}] ${issue.message}`).join("\n");

  return {
    summary,
    detail,
    severity: highestSeverity(report),
    confidence: "high",
    evidence: [],
    assumptions: [],
    openQuestions: report.issues.map((issue) => ({
      text: issue.message,
      severity: issue.severity,
    })),
  };
}

export interface ReviewTaskHandlerOptions extends DeterministicCheckOptions {
  agent?: ReviewAgent;
}

/** Deterministic checks first, then one high-tier narrative review. */
export function createReviewTaskHandler(options: ReviewTaskHandlerOptions = {}): TaskHandler {
  return {
    role: "independent-review",
    async executeAsync(ctx: TaskExecutionContext): Promise<TaskOutput> {
      const agent: ReviewAgent = options.agent ?? ctx.agents.require("independent-review");
      const report = runDeterministicChecks(ctx.upstreamFindings, options);
      const input: ReviewInput = {
        case: {
          title: ctx.case.title,
          ...(ctx.case.description ? { description: ctx.case.description } : {}),
          ...(ctx.case.useCase ? { useCase: ctx.case.useCase } : {}),
        },
        task: {
          title: ctx.task.title,
          ...(ctx.task.instructions ? { instructions: ctx.task.instructions } : {}),
        },
        findings: toPriorFindings(ctx),
        deterministicChecks: {
          passed: report.passed,
          issues: report.issues.map(({ check, severity, message }) => ({
            check,
            severity,
            message,
          })),
        },
      };
      const result = await agent.runAsync(input, agentContextFor(ctx));
      const checks = verificationFinding(report);

      return {
        findings: [checks, ...result.output.findings],
        openQuestions: result.output.openQuestions,
        sections: [
          {
            title: "Verification checks",
            kind: "text",
            content: [checks.summary, checks.detail].filter(Boolean).join("\n\n"),
            findingIndexes: [0],
          },
          ...(result.output.section
            ? [
                {
                  ...result.output.section,
                  findingIndexes: result.output.section.findingIndexes?.map((index) => index + 1),
                },
              ]
            : []),
        ],
        usage: result.usage,
        cost: result.cost,
        modelTier: result.modelTier,
      };
    },
  };
}
