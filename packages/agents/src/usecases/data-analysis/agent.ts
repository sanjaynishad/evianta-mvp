import { confidenceLevelSchema, findingSeveritySchema, type ModelTier } from "@evianta/core";
import { z } from "zod";

import { defineAgent, type Agent, type AnyAgent } from "../../agent.js";
import {
  SPECIALIST_DEFINITIONS,
  specialistInputSchema,
  type SpecialistInput,
} from "../../agents/specialist.js";
import { openQuestionDraftSchema } from "../../findings.js";

export const analystInsightSchema = z.object({
  summary: z.string().min(1),
  detail: z.string().optional(),
  severity: findingSeveritySchema,
  confidence: confidenceLevelSchema.default("medium"),
  /** Ids from context.metrics that the insight relies on. */
  metricIds: z.array(z.string()).default([]),
  anomalyIds: z.array(z.string()).default([]),
  issueIds: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(openQuestionDraftSchema).default([]),
});

export type AnalystInsight = z.infer<typeof analystInsightSchema>;

export const dataAnalystOutputSchema = z.object({
  summary: z.string().min(1),
  trends: z.string().default(""),
  anomalies: z.string().default(""),
  insights: z.array(analystInsightSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(openQuestionDraftSchema).default([]),
});

export type DataAnalystOutput = z.infer<typeof dataAnalystOutputSchema>;

export type DataAnalystOutputInput = z.input<typeof dataAnalystOutputSchema>;

export type DataAnalystAgent = Agent<SpecialistInput, DataAnalystOutput>;

export const DATA_ANALYST_MAX_OUTPUT_TOKENS = 4096;

export const DATA_ANALYST_SYSTEM_PROMPT = [
  "You are the business-data-analyst in a professional workspace that prepares work for human review.",
  "All arithmetic is already done. context.dataset describes the analyzed table, context.metrics lists every computed metric (id, label, value, unit), and context also holds monthly periods, segment breakdowns, anomalies, data-quality issues, and a few sample rows.",
  "Never compute, estimate, round, or restate a number yourself. To mention any figure, write its placeholder {{metric-id}} with an id from context.metrics; it is replaced with the exact value. Small counts and years may be written as words or digits; any other digits are flagged for review.",
  "Write a short summary (2 to 4 sentences), trends (overall direction, month-over-month movement, strongest and weakest segments), and anomalies (explain each flagged period; give possible causes as hypotheses to confirm, not facts).",
  "Return insights for the points a reviewer should act on. Each insight lists the metricIds, anomalyIds, and issueIds it relies on; an insight with severity high or medium must cite at least one of them.",
  "Reference data-quality issues by their issueIds and explain how they could affect the conclusions.",
  "List assumptions you rely on and openQuestions (with a severity) for anything the data cannot answer.",
  "Do not invent columns, periods, segments, causes, or metrics that are not in the context. Keep every text field concise.",
].join("\n");

export interface DataAnalystAgentOverrides {
  modelTier?: ModelTier;
  systemPrompt?: string;
}

/** The business-data-analyst agent: one structured call that interprets precomputed metrics. */
export function createDataAnalystAgent(
  overrides: DataAnalystAgentOverrides = {},
): DataAnalystAgent {
  const { profile } = SPECIALIST_DEFINITIONS["business-data-analyst"];
  const modelTier = overrides.modelTier ?? profile.modelTier;

  return defineAgent<SpecialistInput, DataAnalystOutput>({
    role: "business-data-analyst",
    modelTier,
    systemPrompt: overrides.systemPrompt ?? DATA_ANALYST_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: dataAnalystOutputSchema,
    maxOutputTokens: DATA_ANALYST_MAX_OUTPUT_TOKENS,
    profile: { ...profile, modelTier },
  });
}

export function isDataAnalystAgent(agent: AnyAgent | undefined): agent is DataAnalystAgent {
  return agent?.role === "business-data-analyst" && agent.outputSchema === dataAnalystOutputSchema;
}
