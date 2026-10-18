import { AiError, emptyUsage, type AiClient, type Cost } from "@evianta/ai";
import {
  buildIntakeRequirements,
  chatMessageText,
  clarificationKindSchema,
  composeRulesIntakeReply,
  inferUseCaseFromText,
  useCaseDefinitions,
  useCaseOrder,
  useCaseSchema,
  type Case,
  type ChatMessage,
  type ClarificationKind,
  type IntakeRequirement,
  type ModelTier,
  type SourceProposal,
  type TokenUsage,
  type UseCase,
} from "@evianta/core";
import { z } from "zod";

import { truncate } from "./text.js";

export const INTAKE_AGENT_KEY = "intake";

export const DEFAULT_INTAKE_TIER: ModelTier = "cheap";

export const INTAKE_MAX_CLARIFICATIONS = 2;

export const INTAKE_TITLE_MAX_LENGTH = 80;

export const INTAKE_DESCRIPTION_MAX_LENGTH = 400;

const INTAKE_HISTORY_MESSAGES = 8;

const INTAKE_MAX_DOCUMENTS = 20;

const ATTACHED_FILES_TEXT = "(attached files)";

export const intakeAgentInputSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })),
  catalog: z.array(z.object({ id: useCaseSchema, title: z.string(), outcome: z.string() })),
  currentUseCase: useCaseSchema.nullable(),
  suggestedUseCase: useCaseSchema.nullable(),
  requirements: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      requirement: z.enum(["recommended", "optional"]),
      status: z.enum(["missing", "received", "skipped"]),
    }),
  ),
  documents: z.array(
    z.object({ name: z.string(), mimeType: z.string(), summary: z.string().optional() }),
  ),
  pendingDataSourceProposals: z.array(z.string()),
  clarifications: z.array(z.object({ text: z.string(), answer: z.string().optional() })),
});

export type IntakeAgentInput = z.infer<typeof intakeAgentInputSchema>;

export const intakeAgentOutputSchema = z.object({
  useCase: useCaseSchema.nullable(),
  switchRequested: z.boolean().default(false),
  supported: z.boolean(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  reply: z.string().min(1),
  clarifications: z
    .array(
      z.object({
        text: z.string(),
        kind: clarificationKindSchema.default("text"),
        options: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

export type IntakeAgentOutput = z.infer<typeof intakeAgentOutputSchema>;

export const INTAKE_SYSTEM_PROMPT = [
  "You are the intake assistant for a service that prepares professional work for clients in India.",
  "Only these three kinds of work are supported:",
  ...useCaseOrder.map((id) => {
    const definition = useCaseDefinitions[id];

    return `- ${id}: ${definition.title}. ${definition.outcome}`;
  }),
  "Read the conversation and decide which kind of work the user needs. Set useCase to its id, or null when it is not yet clear.",
  "currentUseCase is the kind of work already chosen for this case. Keep it unless the user explicitly asks to change to another kind of work; only then set switchRequested to true and useCase to the new id.",
  "suggestedUseCase is a keyword guess; confirm or override it from the conversation.",
  "If the request is clearly outside the three kinds of work, set supported to false and useCase to null, politely decline, and invite the user to pick one of the three.",
  "The requirements list is the complete document checklist for the work. Never invent document requirements beyond it. The checklist is shown to the user separately.",
  'When you mention data the user still needs to provide, say they can upload it or get it from a data source. Use "data sources" for connected systems.',
  'Never call the outputs "sources"; the outputs are evidence.',
  'Ask at most two short clarifying questions, only for facts the work needs that the documents do not give, such as the assessment year, a notice date, or the period to analyse. Never ask for documents or files in a clarifying question. Use kind "date" for dates and kind "choice" with options for a small fixed set. Do not repeat questions already listed in clarifications.',
  "When the kind of work is known, propose a short case title (at most 80 characters) and a one or two sentence description (at most 400 characters) based on what the user said.",
  "Do not promise results or legal outcomes.",
  "Be concise: at most about 90 words. Write plain text with no markdown headings and no em dashes.",
  "Use Indian conventions: amounts in INR, and assessment year (AY) and financial year (FY) for tax periods.",
].join("\n");

export interface IntakeDocumentSummary {
  id: string;
  name: string;
  mimeType: string;
  summary?: string;
}

export interface IntakeTurnInput {
  caseRecord: Case;
  /** Full thread, oldest first; the newest user message is last. */
  messages: ChatMessage[];
  documents: IntakeDocumentSummary[];
  pendingProposals: Pick<SourceProposal, "label" | "checklistItemId">[];
}

export interface IntakeClarificationDraft {
  text: string;
  kind: ClarificationKind;
  options?: string[];
}

export interface IntakeTurnResult {
  /** The use case to apply after this turn. */
  useCase: UseCase | undefined;
  /** False when the request is clearly outside the supported kinds of work. */
  supported: boolean;
  title?: string;
  description?: string;
  reply: string;
  clarifications: IntakeClarificationDraft[];
  generatedBy: "model" | "rules";
  usage: TokenUsage;
  cost: Cost;
}

export interface IntakeTurnDependencies {
  ai: AiClient;
  tier?: ModelTier;
}

const DOCUMENT_REQUEST_PATTERNS = [
  /\b(upload|attach)/i,
  /\b(share|send|provide)\b.*\b(files?|documents?|cop(y|ies)|pdfs?|scans?)\b/i,
];

export function removeEmDashes(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/ \u2013 /g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

function userTexts(messages: readonly ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => chatMessageText(message))
    .join("\n");
}

function suggestUseCase(input: IntakeTurnInput): UseCase | undefined {
  return inferUseCaseFromText(
    userTexts(input.messages),
    input.documents.map((document) => document.name),
  ).useCase;
}

function requirementsFor(
  useCase: UseCase | undefined,
  input: IntakeTurnInput,
): IntakeRequirement[] {
  if (!useCase) {
    return [];
  }

  return buildIntakeRequirements(useCase, input.documents, input.caseRecord.intake);
}

function useCaseProposal(
  useCase: UseCase | undefined,
): Pick<IntakeTurnResult, "title" | "description"> {
  if (!useCase) {
    return {};
  }

  const definition = useCaseDefinitions[useCase];

  return { title: definition.exampleTitle, description: definition.exampleDescription };
}

/** Deterministic intake turn used when the model is unavailable or its output is unusable. */
export function rulesIntakeTurn(input: IntakeTurnInput): IntakeTurnResult {
  const useCase = input.caseRecord.useCase ?? suggestUseCase(input);
  const reply = composeRulesIntakeReply({
    useCase,
    requirements: requirementsFor(useCase, input),
    pendingProposals: input.pendingProposals,
    hasDocuments: input.documents.length > 0,
  });

  return {
    useCase,
    supported: true,
    ...useCaseProposal(useCase),
    reply: removeEmDashes(reply),
    clarifications: [],
    generatedBy: "rules",
    usage: emptyUsage(),
    cost: 0,
  };
}

function messageTextForModel(message: ChatMessage): string {
  const text = chatMessageText(message).trim();

  if (text) {
    return truncate(text, 1500);
  }

  if (message.role === "user" && message.parts.some((part) => part.type === "attachments")) {
    return ATTACHED_FILES_TEXT;
  }

  return "";
}

export function buildIntakeAgentInput(input: IntakeTurnInput): IntakeAgentInput {
  const currentUseCase = input.caseRecord.useCase;
  const suggestedUseCase = currentUseCase ? undefined : suggestUseCase(input);

  return {
    messages: input.messages
      .map((message) => ({ role: message.role, text: messageTextForModel(message) }))
      .filter((message) => message.text.length > 0)
      .slice(-INTAKE_HISTORY_MESSAGES),
    catalog: useCaseOrder.map((id) => ({
      id,
      title: useCaseDefinitions[id].title,
      outcome: useCaseDefinitions[id].outcome,
    })),
    currentUseCase: currentUseCase ?? null,
    suggestedUseCase: suggestedUseCase ?? null,
    requirements: requirementsFor(currentUseCase ?? suggestedUseCase, input).map((entry) => ({
      id: entry.item.id,
      label: entry.item.label,
      requirement: entry.item.requirement,
      status: entry.status,
    })),
    documents: input.documents.slice(0, INTAKE_MAX_DOCUMENTS).map((document) => ({
      name: truncate(document.name, 200),
      mimeType: document.mimeType,
      ...(document.summary ? { summary: truncate(document.summary, 300) } : {}),
    })),
    pendingDataSourceProposals: input.pendingProposals.map((proposal) => proposal.label),
    clarifications: (input.caseRecord.intake?.clarifications ?? []).map((clarification) => ({
      text: clarification.text,
      ...(clarification.answer ? { answer: clarification.answer } : {}),
    })),
  };
}

function resolveUseCase(
  current: UseCase | undefined,
  output: IntakeAgentOutput,
): UseCase | undefined {
  if (!output.supported) {
    return undefined;
  }

  if (!current) {
    return output.useCase ?? undefined;
  }

  if (output.switchRequested && output.useCase && output.useCase !== current) {
    return output.useCase;
  }

  return current;
}

function normalizeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function asksForDocuments(text: string): boolean {
  return DOCUMENT_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

export function filterIntakeClarifications(
  drafts: IntakeAgentOutput["clarifications"],
  existingTexts: readonly string[],
): IntakeClarificationDraft[] {
  const seen = new Set(existingTexts.map(normalizeKey));
  const kept: IntakeClarificationDraft[] = [];

  for (const draft of drafts) {
    const text = removeEmDashes(draft.text);
    const key = normalizeKey(text);

    if (!text || seen.has(key) || asksForDocuments(text)) {
      continue;
    }

    seen.add(key);
    const options = (draft.options ?? []).map((option) => option.trim()).filter(Boolean);

    if (draft.kind === "choice" && options.length > 0) {
      kept.push({ text, kind: "choice", options });
    } else {
      kept.push({ text, kind: draft.kind === "choice" ? "text" : draft.kind });
    }

    if (kept.length >= INTAKE_MAX_CLARIFICATIONS) {
      break;
    }
  }

  return kept;
}

function clampText(value: string | null | undefined, maxLength: number): string | undefined {
  const text = removeEmDashes((value ?? "").replace(/\s+/g, " "));

  return text ? truncate(text, maxLength) : undefined;
}

/** Applies the deterministic merge rules to the model's output for one intake turn. */
export function mergeIntakeOutput(
  input: IntakeTurnInput,
  output: IntakeAgentOutput,
  usage: TokenUsage,
  cost: Cost,
): IntakeTurnResult | undefined {
  const reply = removeEmDashes(output.reply);

  if (!reply) {
    return undefined;
  }

  const useCase = resolveUseCase(input.caseRecord.useCase, output);
  const title = useCase ? clampText(output.title, INTAKE_TITLE_MAX_LENGTH) : undefined;
  const description = useCase
    ? clampText(output.description, INTAKE_DESCRIPTION_MAX_LENGTH)
    : undefined;
  const existingTexts = (input.caseRecord.intake?.clarifications ?? []).map((item) => item.text);

  return {
    useCase,
    supported: output.supported,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    reply,
    clarifications: filterIntakeClarifications(output.clarifications, existingTexts),
    generatedBy: "model",
    usage,
    cost,
  };
}

/**
 * One conversational intake turn: the model classifies the request, words the reply, and may ask
 * up to two clarifying questions. The document checklist always comes from the deterministic rules.
 */
export async function runIntakeTurnAsync(
  input: IntakeTurnInput,
  deps: IntakeTurnDependencies,
): Promise<IntakeTurnResult> {
  let result;

  try {
    result = await deps.ai.runStructuredAsync({
      tier: deps.tier ?? DEFAULT_INTAKE_TIER,
      key: INTAKE_AGENT_KEY,
      inputSchema: intakeAgentInputSchema,
      outputSchema: intakeAgentOutputSchema,
      system: INTAKE_SYSTEM_PROMPT,
      input: buildIntakeAgentInput(input),
      maxOutputTokens: 768,
      temperature: 0,
    });
  } catch (error) {
    const fallback = rulesIntakeTurn(input);

    if (error instanceof AiError) {
      return { ...fallback, usage: error.usage, cost: error.cost };
    }

    return fallback;
  }

  const merged = mergeIntakeOutput(input, result.output, result.usage, result.cost);

  return merged ?? { ...rulesIntakeTurn(input), usage: result.usage, cost: result.cost };
}
