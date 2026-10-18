import type { AiClient, Cost } from "@evianta/ai";
import type {
  AgentProfile,
  AgentRole,
  Case,
  Citation,
  ModelTier,
  Task,
  TokenUsage,
} from "@evianta/core";
import type { z } from "zod";

import type { DocumentSlice } from "./slices.js";

export interface AgentLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: AgentLogger = {
  info() {},
  warn() {},
};

export interface AgentContext {
  ai: AiClient;
  case: Case;
  task?: Task;
  documents: DocumentSlice[];
  logger: AgentLogger;
}

export interface AgentResult<O> {
  output: O;
  usage: TokenUsage;
  cost: Cost;
  modelTier: ModelTier;
  attempts: number;
  citations: Citation[];
  /** True when grounding was requested but returned no citations. */
  needsVerification: boolean;
}

export interface Agent<I, O> {
  role: AgentRole;
  modelTier: ModelTier;
  systemPrompt: string;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
  /** Google Search grounding; only research agents enable it. */
  grounding?: boolean;
  maxOutputTokens?: number;
  profile: AgentProfile;
  runAsync(input: I, ctx: AgentContext): Promise<AgentResult<O>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgent = Agent<any, any>;

export type AgentDefinition<I, O> = Omit<Agent<I, O>, "runAsync">;

/** Builds an agent whose output is validated by the AI layer. */
export function defineAgent<I, O>(definition: AgentDefinition<I, O>): Agent<I, O> {
  if (definition.profile.role !== definition.role) {
    throw new Error(
      `Agent profile role "${definition.profile.role}" does not match "${definition.role}".`,
    );
  }

  if (definition.profile.modelTier !== definition.modelTier) {
    throw new Error(`Agent profile tier for "${definition.role}" does not match the agent tier.`);
  }

  return {
    ...definition,
    async runAsync(input, ctx) {
      const result = await ctx.ai.runStructuredAsync({
        tier: definition.modelTier,
        key: definition.role,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        system: definition.systemPrompt,
        input,
        grounding: definition.grounding === true,
        maxOutputTokens: definition.maxOutputTokens,
      });

      ctx.logger.info("Model call finished.", {
        caseId: ctx.case.id,
        taskId: ctx.task?.id,
        role: definition.role,
        modelAttempts: result.diagnostics,
        usage: result.usage,
        cost: result.cost,
      });

      return {
        output: result.output as O,
        usage: result.usage,
        cost: result.cost,
        modelTier: result.tier,
        attempts: result.attempts,
        citations: result.citations ?? [],
        needsVerification: result.needsVerification,
      };
    },
  };
}
