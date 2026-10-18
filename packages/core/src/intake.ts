import { z } from "zod";

import type { UseCase } from "./case.js";
import {
  lowerFirstWord,
  matchChecklistItem,
  useCaseDefinitions,
  type ChecklistItem,
} from "./catalog.js";
import { sourceConnectorIdSchema } from "./sources.js";

export const intakeModeSchema = z.enum(["chat", "form"]);

export type IntakeMode = z.infer<typeof intakeModeSchema>;

export const intakeStageSchema = z.enum(["gathering", "submitted"]);

export type IntakeStage = z.infer<typeof intakeStageSchema>;

export const clarificationKindSchema = z.enum(["text", "date", "choice"]);

export type ClarificationKind = z.infer<typeof clarificationKindSchema>;

export const intakeClarificationSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  kind: clarificationKindSchema.default("text"),
  options: z.array(z.string()).optional(),
  answer: z.string().optional(),
});

export type IntakeClarification = z.infer<typeof intakeClarificationSchema>;

export const clarificationAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export function withClarifications(intake: CaseIntake | undefined): {
  clarifications?: ClarificationAnswer[];
} {
  const clarifications = (intake?.clarifications ?? []).flatMap((clarification) => {
    const answer = clarification.answer?.trim();
    return answer ? [{ question: clarification.text, answer }] : [];
  });
  return clarifications.length > 0 ? { clarifications } : {};
}

export const INTAKE_MAX_REQUEST_MESSAGES = 20;
export const INTAKE_MAX_REQUEST_MESSAGE_LENGTH = 2000;

/** Records what the user typed while setting up the case, keeping the most recent messages. */
export function appendRequestMessage(intake: CaseIntake, text: string): CaseIntake {
  const message = text.trim().slice(0, INTAKE_MAX_REQUEST_MESSAGE_LENGTH);

  if (!message) {
    return intake;
  }

  return {
    ...intake,
    requestMessages: [...intake.requestMessages, message].slice(-INTAKE_MAX_REQUEST_MESSAGES),
  };
}

/** Answered clarifications and the user's setup messages, as passed to planning and specialists. */
export function withIntakeContext(intake: CaseIntake | undefined): {
  clarifications?: ClarificationAnswer[];
  requestMessages?: string[];
} {
  const requestMessages = intake?.requestMessages ?? [];

  return {
    ...withClarifications(intake),
    ...(requestMessages.length > 0 ? { requestMessages: [...requestMessages] } : {}),
  };
}

export const sourceProposalStatusSchema = z.enum(["proposed", "attached", "dismissed"]);

export type SourceProposalStatus = z.infer<typeof sourceProposalStatusSchema>;

export const sourceProposalSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectorId: sourceConnectorIdSchema,
  itemId: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  checklistItemId: z.string(),
  status: sourceProposalStatusSchema.default("proposed"),
  documentIds: z.array(z.string()).default([]),
});

export type SourceProposal = z.infer<typeof sourceProposalSchema>;

export const caseIntakeSchema = z.object({
  mode: intakeModeSchema.default("form"),
  // Set when a draft moved from one entry mode to the other.
  switchedFrom: intakeModeSchema.optional(),
  stage: intakeStageSchema.default("gathering"),
  // False when the request falls outside the supported kinds of work.
  supported: z.boolean().default(true),
  enabledConnectionIds: z.array(z.string()).default([]),
  skippedItemIds: z.array(z.string()).default([]),
  // Explicit checklist assignment by document id; wins over file-name matching.
  documentItems: z.record(z.string(), z.string()).default({}),
  proposals: z.array(sourceProposalSchema).default([]),
  clarifications: z.array(intakeClarificationSchema).default([]),
  // Messages typed in chat before the work started, oldest first; later ones may correct earlier ones.
  requestMessages: z.array(z.string()).default([]),
});

export type CaseIntake = z.infer<typeof caseIntakeSchema>;

export type CaseIntakeInput = z.input<typeof caseIntakeSchema>;

export function createCaseIntake(mode: IntakeMode): CaseIntake {
  return caseIntakeSchema.parse({ mode });
}

export type RequirementStatus = "missing" | "received" | "skipped";

export interface IntakeRequirement {
  item: ChecklistItem;
  status: RequirementStatus;
  documentIds: string[];
}

export interface IntakeDocumentRef {
  id: string;
  name: string;
}

export function assignDocumentsToChecklist(
  useCase: UseCase,
  documents: readonly IntakeDocumentRef[],
  intake?: Pick<CaseIntake, "documentItems">,
): Map<string, string[]> {
  const checklist = useCaseDefinitions[useCase].checklist;
  const assigned = new Map<string, string[]>(checklist.map((item) => [item.id, []]));

  for (const document of documents) {
    const explicit = intake?.documentItems[document.id];
    const itemId =
      explicit && assigned.has(explicit)
        ? explicit
        : matchChecklistItem(document.name, checklist)?.id;

    if (itemId) {
      assigned.get(itemId)?.push(document.id);
    }
  }

  return assigned;
}

export function buildIntakeRequirements(
  useCase: UseCase,
  documents: readonly IntakeDocumentRef[],
  intake?: Pick<CaseIntake, "documentItems" | "skippedItemIds">,
): IntakeRequirement[] {
  const assigned = assignDocumentsToChecklist(useCase, documents, intake);
  const skipped = new Set(intake?.skippedItemIds ?? []);

  return useCaseDefinitions[useCase].checklist.map((item) => {
    const documentIds = assigned.get(item.id) ?? [];
    const status: RequirementStatus =
      documentIds.length > 0 ? "received" : skipped.has(item.id) ? "skipped" : "missing";

    return { item, status, documentIds };
  });
}

export interface IntakeProgress {
  recommendedTotal: number;
  recommendedReceived: number;
  // Recommended items that are neither received nor skipped.
  missingRecommended: ChecklistItem[];
  // Every recommended item is received or skipped.
  complete: boolean;
}

export function summarizeIntakeRequirements(
  requirements: readonly IntakeRequirement[],
): IntakeProgress {
  const recommended = requirements.filter((entry) => entry.item.requirement === "recommended");
  const missingRecommended = recommended
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.item);

  return {
    recommendedTotal: recommended.length,
    recommendedReceived: recommended.filter((entry) => entry.status === "received").length,
    missingRecommended,
    complete: missingRecommended.length === 0,
  };
}

export function pendingSourceProposals(intake: CaseIntake | undefined): SourceProposal[] {
  return (intake?.proposals ?? []).filter((proposal) => proposal.status === "proposed");
}

export interface IntakeChange {
  mode?: IntakeMode;
  enabledConnectionIds?: string[];
  skipItem?: { itemId: string; skipped: boolean };
  assignDocument?: { documentId: string; itemId: string | null };
  answerClarification?: { id: string; answer: string };
}

// Applies one PATCH /cases/:id/intake change. Connection ids the visitor does not own are dropped.
export function applyIntakeChange(
  current: CaseIntake,
  change: IntakeChange,
  ownedConnectionIds: ReadonlySet<string>,
): CaseIntake {
  // Parsing returns fresh objects and arrays, so the caller's intake is never mutated.
  const next: CaseIntake = caseIntakeSchema.parse(current);

  if (change.mode && change.mode !== next.mode) {
    next.switchedFrom = next.mode;
    next.mode = change.mode;
  }

  if (change.enabledConnectionIds) {
    next.enabledConnectionIds = [...new Set(change.enabledConnectionIds)].filter((id) =>
      ownedConnectionIds.has(id),
    );
  }

  if (change.skipItem) {
    const skipped = new Set(next.skippedItemIds);

    if (change.skipItem.skipped) {
      skipped.add(change.skipItem.itemId);
    } else {
      skipped.delete(change.skipItem.itemId);
    }

    next.skippedItemIds = [...skipped];
  }

  if (change.assignDocument) {
    const { documentId, itemId } = change.assignDocument;

    if (itemId) {
      next.documentItems[documentId] = itemId;
    } else {
      delete next.documentItems[documentId];
    }
  }

  if (change.answerClarification) {
    const { id, answer } = change.answerClarification;

    next.clarifications = next.clarifications.map((clarification) =>
      clarification.id === id ? { ...clarification, answer: answer || undefined } : clarification,
    );
  }

  return next;
}

export interface ProposableSourceItem {
  id: string;
  connectionId: string;
  connectorId: SourceProposal["connectorId"];
  label: string;
  detail?: string;
  satisfies: string[];
}

export function sourceProposalId(connectionId: string, itemId: string): string {
  return `${connectionId}:${itemId}`;
}

// Proposes items from the enabled data sources for checklist items that are still missing, and
// withdraws open proposals whose source was turned off or whose item is no longer missing.
// Attached and dismissed proposals are kept.
export function refreshSourceProposals(
  intake: CaseIntake,
  requirements: readonly IntakeRequirement[],
  items: readonly ProposableSourceItem[],
): CaseIntake {
  const enabled = new Set(intake.enabledConnectionIds);
  const missing = new Set(
    requirements.filter((entry) => entry.status === "missing").map((entry) => entry.item.id),
  );
  const kept = intake.proposals.filter(
    (proposal) =>
      proposal.status !== "proposed" ||
      (enabled.has(proposal.connectionId) && missing.has(proposal.checklistItemId)),
  );
  const known = new Set(kept.map((proposal) => proposal.id));
  const added: SourceProposal[] = [];

  for (const item of items) {
    if (!enabled.has(item.connectionId)) {
      continue;
    }

    const id = sourceProposalId(item.connectionId, item.id);
    const checklistItemId = item.satisfies.find((itemId) => missing.has(itemId));

    if (!checklistItemId || known.has(id)) {
      continue;
    }

    known.add(id);
    added.push(
      sourceProposalSchema.parse({
        id,
        connectionId: item.connectionId,
        connectorId: item.connectorId,
        itemId: item.id,
        label: item.label,
        detail: item.detail,
        checklistItemId,
      }),
    );
  }

  return { ...intake, proposals: [...kept, ...added] };
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) {
    return labels.join("");
  }

  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export interface RulesIntakeReplyInput {
  useCase: UseCase | undefined;
  requirements: readonly IntakeRequirement[];
  pendingProposals: readonly Pick<SourceProposal, "label">[];
  hasDocuments: boolean;
}

// Deterministic intake reply used when the intake model is unavailable and in offline fixture mode.
export function composeRulesIntakeReply(input: RulesIntakeReplyInput): string {
  if (!input.useCase) {
    const opening = input.hasDocuments
      ? "Thanks, I have your files."
      : "I can take on three kinds of work.";

    return `${opening} Which of these fits what you need? Pick one below, or tell me a little more and I will work it out.`;
  }

  const definition = useCaseDefinitions[input.useCase];
  const progress = summarizeIntakeRequirements(input.requirements);
  const sentences = [
    `This looks like ${definition.inlineTitle}. You will get ${lowerFirstWord(definition.outcome)}`,
  ];

  if (progress.missingRecommended.length > 0) {
    sentences.push(
      `To prepare it well I still need ${joinLabels(
        progress.missingRecommended.map((item) => lowerFirstWord(item.label)),
      )}. Upload them, get them from a data source, or mark any you do not have.`,
    );
  } else {
    sentences.push("I have everything I need. Check the list below and submit when you are ready.");
  }

  if (input.pendingProposals.length > 0) {
    const count = input.pendingProposals.length;

    sentences.push(
      `I found ${count} ${count === 1 ? "item" : "items"} in your data sources that may fit.`,
    );
  }

  return sentences.join(" ");
}
