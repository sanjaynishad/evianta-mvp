import { z } from "zod";

export const agentRoleSchema = z.enum([
  "coordinator",
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
  "independent-review",
]);

export type AgentRole = z.infer<typeof agentRoleSchema>;

export const modelTierSchema = z.enum(["cheap", "mid", "high"]);

export type ModelTier = z.infer<typeof modelTierSchema>;

export const agentProfileSchema = z.object({
  role: agentRoleSchema,
  displayName: z.string().min(1),
  specialty: z.string(),
  summary: z.string(),
  capabilities: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  procedures: z.array(z.string()).default([]),
  outputFormats: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  modelTier: modelTierSchema,
  enabled: z.boolean().default(true),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

export type AgentProfileInput = z.input<typeof agentProfileSchema>;
