import {
  applyIntakeChange,
  buildIntakeRequirements,
  chatMessageRequestSchema,
  chatMessageSchema,
  chatStageOf,
  chatStoppedReply,
  chatWorkingReply,
  composeRulesIntakeReply,
  createCaseIntake,
  findSourceConnector,
  inferUseCaseFromText,
  intakeReplyParts,
  pendingSourceProposals,
  refreshSourceProposals,
  sourceConnectorCatalog,
  sourceProposalId,
  untitledChatTitle,
  useCaseDefinitions,
  type Case,
  type CaseDocument,
  type CaseIntake,
  type CaseState,
  type ChatMessage,
  type ChatMessageInput,
  type ChatPart,
  type SourceConnection,
  type SourceItem,
  type SourceProposal,
} from "@evianta/core";
import { extractionSummary } from "@/fixtures/documents";
import { ApiError } from "@/lib/api/errors";
import type { CaseDataSource } from "./types";

type FixtureChatMethods = Pick<
  CaseDataSource,
  | "updateCaseAsync"
  | "updateIntakeAsync"
  | "listMessagesAsync"
  | "sendMessageAsync"
  | "listSourceConnectorsAsync"
  | "listSourceConnectionsAsync"
  | "connectSourceAsync"
  | "disconnectSourceAsync"
  | "listSourceItemsAsync"
  | "actOnSourceProposalsAsync"
  | "importSourceItemAsync"
>;

export interface FixtureChat extends FixtureChatMethods {
  recordRunMessage(caseId: string, runId: string, mode: "run" | "retry"): void;
}

export interface FixtureChatDependencies {
  now: () => Date;
  visitorId: () => string;
  createId: (prefix: string) => string;
  replayIntervalMs: number;
  getState: (caseId: string) => CaseState;
  getEditableState: (caseId: string) => CaseState;
  setState: (caseId: string, state: CaseState) => void;
  isRunActive: (caseId: string) => boolean;
  askAsync: CaseDataSource["askAsync"];
}

const WORDS_PER_DELTA = 5;

function chunkWords(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += WORDS_PER_DELTA) {
    chunks.push(words.slice(index, index + WORDS_PER_DELTA).join(""));
  }

  return chunks;
}

function demoItemFileName(item: { connectorId: string; datasetId: string }): string {
  return `${item.connectorId}-${item.datasetId}-demo.csv`;
}

export function fixtureSourceItems(connection: SourceConnection): SourceItem[] {
  const connector = findSourceConnector(connection.connectorId);
  return (connector?.datasets ?? []).map((dataset) => ({
    id: dataset.id,
    connectionId: connection.id,
    connectorId: connection.connectorId,
    datasetId: dataset.id,
    label: dataset.label,
    detail: "Demo data",
    fileName: demoItemFileName({ connectorId: connection.connectorId, datasetId: dataset.id }),
    mimeType: "text/csv",
    satisfies: dataset.satisfies,
  }));
}

export function createFixtureChat(deps: FixtureChatDependencies): FixtureChat {
  const messages = new Map<string, ChatMessage[]>();
  const connections = new Map<string, SourceConnection>();

  function wait<T>(value: T, ms = 0): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  function appendMessage(
    caseId: string,
    input: Omit<ChatMessageInput, "id" | "caseId" | "createdAt">,
  ) {
    const message = chatMessageSchema.parse({
      ...input,
      id: deps.createId("msg"),
      caseId,
      createdAt: deps.now().toISOString(),
    });
    messages.set(caseId, [...(messages.get(caseId) ?? []), message]);
    return message;
  }

  function ownedConnections(): SourceConnection[] {
    const visitor = deps.visitorId();
    return [...connections.values()].filter((connection) => connection.visitorId === visitor);
  }

  function intakeOf(caseRecord: Case): CaseIntake {
    return caseRecord.intake ?? createCaseIntake("form");
  }

  function requireDraft(state: CaseState) {
    if (state.tasks.length > 0 || deps.isRunActive(state.case.id)) {
      throw new ApiError(
        "This case has been planned. Start a new chat to change its details.",
        409,
        { code: "case-already-planned" },
      );
    }
  }

  // Recomputes proposals for the current use case and stores the updated intake.
  function saveIntake(state: CaseState, intake: CaseIntake): CaseState {
    let next = intake;
    if (state.case.useCase) {
      const requirements = buildIntakeRequirements(state.case.useCase, state.documents, next);
      const items = ownedConnections()
        .filter((connection) => next.enabledConnectionIds.includes(connection.id))
        .flatMap(fixtureSourceItems);
      next = refreshSourceProposals(next, requirements, items);
    }

    const updated: CaseState = {
      ...state,
      case: { ...state.case, intake: next, updatedAt: deps.now().toISOString() },
    };
    deps.setState(state.case.id, updated);
    return updated;
  }

  function attachItem(
    caseId: string,
    connection: SourceConnection,
    item: SourceItem,
    checklistItemId: string | undefined,
  ): CaseDocument {
    const document: CaseDocument = {
      id: deps.createId("doc"),
      caseId,
      name: item.fileName,
      mimeType: item.mimeType,
      size: 2048,
      uploadedAt: deps.now().toISOString(),
      status: "ready",
      extraction: extractionSummary("parse", 1),
      provenance: {
        connectorId: item.connectorId,
        connectionId: connection.id,
        itemId: item.id,
        label: item.label,
      },
    };
    const state = deps.getState(caseId);
    const intake = intakeOf(state.case);
    deps.setState(caseId, {
      ...state,
      documents: [...state.documents, document],
      case: {
        ...state.case,
        intake: checklistItemId
          ? {
              ...intake,
              documentItems: { ...intake.documentItems, [document.id]: checklistItemId },
            }
          : intake,
      },
    });
    connections.set(connection.id, { ...connection, lastImportAt: deps.now().toISOString() });
    return document;
  }

  function gatherReply(caseId: string): { parts: ChatPart[]; caseRecord: Case } {
    let state = deps.getState(caseId);
    const userText = (messages.get(caseId) ?? [])
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const useCase =
      state.case.useCase ??
      inferUseCaseFromText(
        userText,
        state.documents.map((document) => document.name),
      ).useCase;

    if (useCase && !state.case.useCase) {
      const definition = useCaseDefinitions[useCase];
      const retitle = state.case.title === untitledChatTitle;
      state = {
        ...state,
        case: {
          ...state.case,
          useCase,
          title: retitle ? definition.exampleTitle : state.case.title,
          description: state.case.description ?? definition.exampleDescription,
        },
      };
    }

    state = saveIntake(state, intakeOf(state.case));
    const intake = intakeOf(state.case);
    const text = composeRulesIntakeReply({
      useCase,
      requirements: useCase ? buildIntakeRequirements(useCase, state.documents, intake) : [],
      pendingProposals: pendingSourceProposals(intake),
      hasDocuments: state.documents.length > 0,
    });
    return {
      parts: intakeReplyParts({ text, useCase, supported: intake.supported }),
      caseRecord: state.case,
    };
  }

  async function followUpReply(caseId: string, question: string): Promise<ChatPart[]> {
    if (!question) {
      return [{ type: "text", text: "Ask me anything about the finished work." }];
    }

    const result = await deps.askAsync(caseId, question);
    if (result.status === "answered") {
      return [
        { type: "text", text: result.answer },
        {
          type: "answer",
          status: "answered",
          evidenceIds: result.evidenceIds,
          findingIds: result.findingIds,
          evidence: result.evidence,
          canFlagForReview: false,
        },
      ];
    }

    return [
      { type: "text", text: result.message },
      {
        type: "answer",
        status: "not-supported",
        evidenceIds: [],
        findingIds: [],
        evidence: [],
        canFlagForReview: result.canFlagForReview,
      },
    ];
  }

  function updateProposals(caseId: string, update: (proposal: SourceProposal) => SourceProposal) {
    const state = deps.getState(caseId);
    const intake = intakeOf(state.case);
    return saveIntake(state, { ...intake, proposals: intake.proposals.map(update) });
  }

  return {
    recordRunMessage(caseId, runId, mode) {
      const state = deps.getState(caseId);
      if (!state.case.intake) {
        return;
      }

      deps.setState(caseId, {
        ...state,
        case: { ...state.case, intake: { ...state.case.intake, stage: "submitted" } },
      });
      appendMessage(caseId, { role: "assistant", parts: [{ type: "run", runId, mode }] });
    },

    async updateCaseAsync(caseId, update) {
      const state = deps.getEditableState(caseId);
      requireDraft(state);
      const caseRecord: Case = {
        ...state.case,
        ...(update.title !== undefined ? { title: update.title.trim() } : {}),
        ...(update.description !== undefined
          ? { description: update.description.trim() || undefined }
          : {}),
        ...(update.useCase !== undefined ? { useCase: update.useCase } : {}),
      };
      const saved = saveIntake({ ...state, case: caseRecord }, intakeOf(caseRecord));
      return wait(structuredClone(saved.case));
    },

    async updateIntakeAsync(caseId, update) {
      const state = deps.getEditableState(caseId);
      requireDraft(state);
      const owned = new Set(ownedConnections().map((connection) => connection.id));
      const next = applyIntakeChange(intakeOf(state.case), update, owned);
      return wait(structuredClone(saveIntake(state, next).case));
    },

    async listMessagesAsync(caseId) {
      deps.getState(caseId);
      return wait(structuredClone(messages.get(caseId) ?? []));
    },

    async sendMessageAsync(caseId, request, options = {}) {
      const state = deps.getEditableState(caseId);
      const parsed = chatMessageRequestSchema.parse(request);
      const userParts: ChatPart[] = [];
      if (parsed.text) {
        userParts.push({ type: "text", text: parsed.text });
      }

      if (parsed.documentIds.length > 0) {
        userParts.push({ type: "attachments", documentIds: parsed.documentIds });
      }

      const userMessage = appendMessage(caseId, { role: "user", parts: userParts });
      options.onUserMessage?.(structuredClone(userMessage));

      const stage = chatStageOf({
        taskCount: state.tasks.length,
        runActive: deps.isRunActive(caseId),
        deliverableCount: state.deliverables.length,
      });
      let parts: ChatPart[];
      if (stage === "gathering") {
        parts = gatherReply(caseId).parts;
      } else if (stage === "working") {
        parts = [{ type: "text", text: chatWorkingReply }];
      } else if (stage === "stopped") {
        parts = [{ type: "text", text: chatStoppedReply }];
      } else {
        parts = await followUpReply(caseId, parsed.text);
      }

      const text = parts.find((part) => part.type === "text");
      for (const chunk of chunkWords(text?.type === "text" ? text.text : "")) {
        if (options.signal?.aborted) {
          throw new DOMException("The reply was stopped.", "AbortError");
        }

        await wait(undefined, Math.min(deps.replayIntervalMs, 40));
        options.onDelta?.(chunk);
      }

      const message = appendMessage(caseId, {
        role: "assistant",
        parts,
        generatedBy: "rules",
      });
      return {
        message: structuredClone(message),
        case: structuredClone(deps.getState(caseId).case),
      };
    },

    async listSourceConnectorsAsync() {
      return wait(structuredClone([...sourceConnectorCatalog]));
    },

    async listSourceConnectionsAsync() {
      return wait(structuredClone(ownedConnections()));
    },

    async connectSourceAsync(connectorId) {
      const connector = findSourceConnector(connectorId);
      if (!connector) {
        throw new ApiError("This data source is not available.", 404, { code: "not-found" });
      }

      const existing = ownedConnections().find(
        (connection) => connection.connectorId === connectorId,
      );
      if (existing) {
        return wait(structuredClone(existing));
      }

      const connection: SourceConnection = {
        id: deps.createId("conn"),
        visitorId: deps.visitorId(),
        connectorId,
        accountLabel: `Demo account: ${connector.name}`,
        status: "connected",
        connectedAt: deps.now().toISOString(),
      };
      connections.set(connection.id, connection);
      return wait(structuredClone(connection), deps.replayIntervalMs);
    },

    async disconnectSourceAsync(connectionId) {
      const connection = connections.get(connectionId);
      if (connection?.visitorId === deps.visitorId()) {
        connections.delete(connectionId);
      }

      await wait(undefined);
    },

    async listSourceItemsAsync(connectionId) {
      const connection = connections.get(connectionId);
      if (!connection || connection.visitorId !== deps.visitorId()) {
        throw new ApiError("This data source is not connected.", 404, { code: "not-found" });
      }

      return wait(fixtureSourceItems(connection));
    },

    async actOnSourceProposalsAsync(caseId, request) {
      const state = deps.getEditableState(caseId);
      requireDraft(state);
      const intake = intakeOf(state.case);
      const selected = new Set(request.proposalIds);
      const documents: CaseDocument[] = [];
      if (request.action === "dismiss") {
        const saved = updateProposals(caseId, (proposal) =>
          selected.has(proposal.id) && proposal.status === "proposed"
            ? { ...proposal, status: "dismissed" }
            : proposal,
        );
        return wait({ documents, case: structuredClone(saved.case) });
      }

      const attachedIds = new Map<string, string>();
      for (const proposal of intake.proposals) {
        if (!selected.has(proposal.id) || proposal.status !== "proposed") {
          continue;
        }

        const connection = connections.get(proposal.connectionId);
        const item = connection
          ? fixtureSourceItems(connection).find((candidate) => candidate.id === proposal.itemId)
          : undefined;
        if (!connection || !item) {
          continue;
        }

        const document = attachItem(caseId, connection, item, proposal.checklistItemId);
        documents.push(document);
        attachedIds.set(proposal.id, document.id);
      }

      const saved = updateProposals(caseId, (proposal) => {
        const documentId = attachedIds.get(proposal.id);
        return documentId
          ? { ...proposal, status: "attached", documentIds: [...proposal.documentIds, documentId] }
          : proposal;
      });
      return wait(
        { documents: structuredClone(documents), case: structuredClone(saved.case) },
        deps.replayIntervalMs,
      );
    },

    async importSourceItemAsync(caseId, request) {
      const state = deps.getEditableState(caseId);
      requireDraft(state);
      const connection = connections.get(request.connectionId);
      if (!connection || connection.visitorId !== deps.visitorId()) {
        throw new ApiError("This data source is not connected.", 404, { code: "not-found" });
      }

      const item = fixtureSourceItems(connection).find(
        (candidate) => candidate.id === request.itemId,
      );
      if (!item) {
        throw new ApiError("This item could not be found in the data source.", 404, {
          code: "not-found",
        });
      }

      const document = attachItem(caseId, connection, item, request.checklistItemId);
      const proposalId = sourceProposalId(connection.id, item.id);
      const saved = updateProposals(caseId, (proposal) =>
        proposal.id === proposalId
          ? { ...proposal, status: "attached", documentIds: [...proposal.documentIds, document.id] }
          : proposal,
      );
      return wait(
        { documents: [structuredClone(document)], case: structuredClone(saved.case) },
        deps.replayIntervalMs,
      );
    },
  };
}
