import { askCaseAsync, runIntakeTurnAsync, summarizeDocument } from "@evianta/agents";
import { AiError } from "@evianta/ai";
import {
  appendRequestMessage,
  chatMessageRequestSchema,
  chatStageOf,
  chatStoppedReply,
  chatWorkingReply,
  createCaseIntake,
  intakeClarificationSchema,
  intakeReplyParts,
  pendingSourceProposals,
  untitledChatTitle,
  type Case,
  type ChatMessage,
  type ChatPart,
  type ChatReplySource,
  type TokenUsage,
} from "@evianta/core";
import { Router } from "express";

import { getCaseOrThrowAsync, getMutableCaseAsync, type ApiContext } from "../context.js";
import { asyncRoute, caseParamsSchema, requireVisitorId } from "../http.js";
import { intakeOf, updateIntakeAsync } from "../intake.js";
import { messageOf } from "../logger.js";
import { openEventStream } from "../sse.js";
import { chunkAnswer } from "./review.js";

interface AssistantReply {
  parts: ChatPart[];
  generatedBy?: ChatReplySource;
  usage?: TokenUsage;
}

export function createChatRoutes(ctx: ApiContext): Router {
  const router = Router();
  const { store } = ctx;

  async function recordUsageAsync(caseId: string, usage: TokenUsage, cost: number) {
    if (usage.total <= 0 && cost <= 0) {
      return;
    }

    try {
      await store.cases.updateCaseUsageAsync(caseId, {
        inputTokens: usage.input,
        outputTokens: usage.output,
        costEstimate: cost,
      });
    } catch (error) {
      ctx.logger.warn("Could not record chat usage.", { caseId, error: messageOf(error) });
    }
  }

  async function isPlannedAsync(caseId: string): Promise<boolean> {
    return ctx.runs.isActive(caseId) || (await store.tasks.getTasksForCaseAsync(caseId)).length > 0;
  }

  async function intakeReplyAsync(
    caseRecord: Case,
    messages: ChatMessage[],
    visitorId: string,
    text: string,
  ): Promise<AssistantReply> {
    const caseId = caseRecord.id;

    // Saved before the model call so corrections reach planning even if the reply fails.
    if (text && !(await isPlannedAsync(caseId))) {
      caseRecord = await store.cases.updateIntakeAsync(caseId, (intake) =>
        appendRequestMessage(intake ?? createCaseIntake("chat"), text),
      );
    }

    const metadata = await store.documents.getDocumentsForCaseAsync(caseId);
    const documents = await Promise.all(
      metadata.map(async (document) => {
        const extraction =
          (await store.documents.getExtractionAsync(caseId, document.id)) ??
          ctx.ingestion.stateOf(caseId, document.id)?.extraction;

        return {
          id: document.id,
          name: document.name,
          mimeType: document.mimeType,
          summary: summarizeDocument(document, extraction),
        };
      }),
    );
    const intake = intakeOf(caseRecord);
    const result = await runIntakeTurnAsync(
      {
        caseRecord,
        messages,
        documents,
        pendingProposals: pendingSourceProposals(intake),
      },
      { ai: ctx.ai },
    );

    await recordUsageAsync(caseId, result.usage, result.cost);

    // An off-topic message never clears a use case the case already has.
    const useCase = result.supported ? result.useCase : caseRecord.useCase;
    let latest = caseRecord;

    if (!(await isPlannedAsync(caseId))) {
      const details = {
        ...(useCase && useCase !== caseRecord.useCase ? { useCase } : {}),
        ...(result.title && caseRecord.title === untitledChatTitle ? { title: result.title } : {}),
        ...(result.description && !caseRecord.description
          ? { description: result.description }
          : {}),
      };

      if (Object.keys(details).length > 0) {
        latest = await store.cases.updateCaseDetailsAsync(caseId, details);
      }

      latest = await updateIntakeAsync(ctx, caseId, visitorId, (current) => {
        const known = new Set(current.clarifications.map((entry) => entry.text.toLowerCase()));
        const added = result.clarifications
          .filter((draft) => !known.has(draft.text.toLowerCase()))
          .map((draft) => intakeClarificationSchema.parse({ ...draft, id: ctx.newId() }));

        return {
          ...current,
          supported: result.supported || Boolean(useCase),
          clarifications: [...current.clarifications, ...added],
        };
      });
    }

    return {
      parts: intakeReplyParts({
        text: result.reply,
        useCase: latest.useCase,
        supported: intakeOf(latest).supported,
      }),
      generatedBy: result.generatedBy,
      ...(result.usage.total > 0 ? { usage: result.usage } : {}),
    };
  }

  async function followUpReplyAsync(caseId: string, question: string): Promise<AssistantReply> {
    if (!question) {
      return { parts: [{ type: "text", text: "Ask me anything about the finished work." }] };
    }

    try {
      const result = await askCaseAsync({ caseId, question }, { store, ai: ctx.ai });

      await recordUsageAsync(caseId, result.usage, result.cost);

      if (result.status === "answered") {
        return {
          parts: [
            { type: "text", text: result.answer },
            {
              type: "answer",
              status: "answered",
              evidenceIds: result.evidenceIds,
              findingIds: result.findingIds,
              evidence: result.evidence,
              canFlagForReview: false,
            },
          ],
          generatedBy: "model",
          usage: result.usage,
        };
      }

      return {
        parts: [
          { type: "text", text: result.message },
          {
            type: "answer",
            status: "not-supported",
            evidenceIds: [],
            findingIds: [],
            evidence: [],
            canFlagForReview: result.canFlagForReview,
          },
        ],
        generatedBy: "model",
        usage: result.usage,
      };
    } catch (error) {
      if (error instanceof AiError) {
        await recordUsageAsync(caseId, error.usage, error.cost);
      }

      throw error;
    }
  }

  router.get(
    "/cases/:caseId/messages",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);

      await getCaseOrThrowAsync(ctx, caseId);

      res.json({ messages: await store.chat.listMessagesAsync(caseId) });
    }),
  );

  router.post(
    "/cases/:caseId/messages",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const visitorId = requireVisitorId(req);
      const request = chatMessageRequestSchema.parse(req.body);
      const caseRecord = await getMutableCaseAsync(ctx, caseId);
      const knownDocumentIds = new Set(
        (await store.documents.getDocumentsForCaseAsync(caseId)).map((document) => document.id),
      );
      const documentIds = request.documentIds.filter((id) => knownDocumentIds.has(id));
      const userParts: ChatPart[] = [
        ...(request.text ? [{ type: "text" as const, text: request.text }] : []),
        ...(documentIds.length > 0 ? [{ type: "attachments" as const, documentIds }] : []),
      ];
      const userMessage = await store.chat.appendMessageAsync(caseId, {
        id: ctx.newId(),
        caseId,
        role: "user",
        createdAt: ctx.now().toISOString(),
        parts: userParts,
      });
      const writer = openEventStream(res);

      writer.send("user-message", userMessage);

      try {
        const [tasks, deliverables] = await Promise.all([
          store.tasks.getTasksForCaseAsync(caseId),
          store.deliverables.getDeliverablesForCaseAsync(caseId),
        ]);
        const stage = chatStageOf({
          taskCount: tasks.length,
          runActive: ctx.runs.isActive(caseId),
          deliverableCount: deliverables.length,
        });
        let reply: AssistantReply;

        if (stage === "gathering") {
          const messages = await store.chat.listMessagesAsync(caseId);

          reply = await intakeReplyAsync(caseRecord, messages, visitorId, request.text);
        } else if (stage === "delivered") {
          reply = await followUpReplyAsync(caseId, request.text);
        } else {
          reply = {
            parts: [
              { type: "text", text: stage === "working" ? chatWorkingReply : chatStoppedReply },
            ],
          };
        }

        const text = reply.parts.find((part) => part.type === "text");

        for (const chunk of chunkAnswer(text?.type === "text" ? text.text : "")) {
          writer.send("reply-delta", { text: chunk });
        }

        const message = await store.chat.appendMessageAsync(caseId, {
          id: ctx.newId(),
          caseId,
          role: "assistant",
          createdAt: ctx.now().toISOString(),
          parts: reply.parts,
          ...(reply.generatedBy ? { generatedBy: reply.generatedBy } : {}),
          ...(reply.usage ? { usage: reply.usage } : {}),
        });

        writer.send("reply", { message, case: await getCaseOrThrowAsync(ctx, caseId) });
      } catch (error) {
        ctx.logger.warn("Chat reply failed.", { caseId, error: messageOf(error) });
        writer.send("error", {
          error: "chat-failed",
          message: "Evianta could not reply right now. Try again.",
        });
      } finally {
        writer.close();
      }
    }),
  );

  return router;
}
