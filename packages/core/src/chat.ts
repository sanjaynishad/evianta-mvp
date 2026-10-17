import { z } from "zod";

import { useCaseSchema, type UseCase } from "./case.js";
import { evidenceSchema } from "./evidence.js";
import { tokenUsageSchema } from "./usage.js";

export const chatRoleSchema = z.enum(["user", "assistant"]);

export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const chatAttachmentsPartSchema = z.object({
  type: z.literal("attachments"),
  documentIds: z.array(z.string()).default([]),
});

// Offers the supported kinds of work; `suggested` is the use case the assistant picked, if any.
export const chatUseCaseChoicePartSchema = z.object({
  type: z.literal("use-case-choice"),
  suggested: useCaseSchema.optional(),
  supported: z.boolean().default(true),
});

// Renders the live intake checklist from the case state, so it never goes stale.
export const chatIntakeRequestPartSchema = z.object({
  type: z.literal("intake-request"),
});

export const chatRunPartSchema = z.object({
  type: z.literal("run"),
  runId: z.string(),
  mode: z.enum(["run", "retry"]).default("run"),
});

// A grounded follow-up answer; its text is in a sibling text part.
export const chatAnswerPartSchema = z.object({
  type: z.literal("answer"),
  status: z.enum(["answered", "not-supported"]),
  evidenceIds: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
  evidence: z.array(evidenceSchema).default([]),
  canFlagForReview: z.boolean().default(false),
});

export const chatPartSchema = z.discriminatedUnion("type", [
  chatTextPartSchema,
  chatAttachmentsPartSchema,
  chatUseCaseChoicePartSchema,
  chatIntakeRequestPartSchema,
  chatRunPartSchema,
  chatAnswerPartSchema,
]);

export type ChatPart = z.infer<typeof chatPartSchema>;

export type ChatPartInput = z.input<typeof chatPartSchema>;

export type ChatPartOfType<TType extends ChatPart["type"]> = Extract<ChatPart, { type: TType }>;

export const chatReplySourceSchema = z.enum(["model", "rules"]);

export type ChatReplySource = z.infer<typeof chatReplySourceSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  role: chatRoleSchema,
  createdAt: z.string(),
  parts: z.array(chatPartSchema).default([]),
  // How an assistant reply was written: by the intake model, or by the deterministic rules.
  generatedBy: chatReplySourceSchema.optional(),
  usage: tokenUsageSchema.optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export type ChatMessageInput = z.input<typeof chatMessageSchema>;

export function chatMessageText(message: Pick<ChatMessage, "parts">): string {
  return message.parts
    .filter((part): part is ChatPartOfType<"text"> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

export type ChatStage = "gathering" | "working" | "delivered" | "stopped";

export interface ChatStageInput {
  taskCount: number;
  runActive: boolean;
  deliverableCount: number;
}

// Where a chat stands: gathering inputs, agents working, work delivered, or a run that stopped.
export function chatStageOf(input: ChatStageInput): ChatStage {
  if (input.runActive) {
    return "working";
  }

  if (input.deliverableCount > 0) {
    return "delivered";
  }

  return input.taskCount > 0 ? "stopped" : "gathering";
}

export const chatWorkingReply =
  "The agents are working on this case. Follow along in the run card above. Once the work is ready you can ask me about it here.";

export const chatStoppedReply =
  "The work stopped before it finished. Retry the failed steps from the run card above, then ask me about the results.";

export interface IntakeReplyPartsInput {
  text: string;
  useCase: UseCase | undefined;
  supported: boolean;
}

// Parts of an assistant reply while a case is being gathered, shared by the API and offline mode.
// The intake card renders the live checklist and data-source proposals from the case state.
export function intakeReplyParts(input: IntakeReplyPartsInput): ChatPart[] {
  return [
    { type: "text", text: input.text },
    input.useCase
      ? { type: "intake-request" }
      : { type: "use-case-choice", supported: input.supported },
  ];
}
