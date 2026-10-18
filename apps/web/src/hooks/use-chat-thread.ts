"use client";

import { useEffect, useRef, useState } from "react";
import type { Case, ChatMessage } from "@evianta/core";
import { useCaseWorkspace, type CaseWorkspaceController } from "@/hooks/use-case-workspace";
import { useResource } from "@/hooks/use-resource";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";

export interface PendingExchange {
  text: string;
  documentIds: string[];
  // Set once the server stored the user message.
  userMessage?: ChatMessage;
  replyText: string;
  error?: string;
}

export interface ChatThreadController {
  workspace: CaseWorkspaceController;
  messages: ChatMessage[];
  messagesLoaded: boolean;
  messagesError: unknown;
  pending: PendingExchange | undefined;
  replying: boolean;
  announcement: string;
  sendAsync: (text: string, documentIds?: string[]) => Promise<boolean>;
  retryPending: () => void;
  dismissPending: () => void;
  stop: () => void;
  applyCase: (caseRecord: Case) => void;
  runAsync: () => Promise<boolean>;
  retryRunAsync: () => Promise<boolean>;
  reloadMessages: () => void;
}

export function useChatThread(
  caseId: string,
  options: { onTryCase?: () => void } = {},
): ChatThreadController {
  const dataSource = useDataSource();
  const workspace = useCaseWorkspace(caseId, { onTryCase: options.onTryCase });
  const messages = useResource(`messages:${caseId}`, () => dataSource.listMessagesAsync(caseId));
  const [pending, setPending] = useState<PendingExchange>();
  const [announcement, setAnnouncement] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const replying = Boolean(pending && !pending.error);
  const { mutate: mutateState } = workspace;
  const { mutate: mutateMessages, reload: reloadMessages } = messages;

  useEffect(() => () => abortRef.current?.abort(), []);

  function applyCase(caseRecord: Case) {
    mutateState((current) => ({ ...current, case: caseRecord }));
  }

  async function sendAsync(text: string, documentIds: string[] = []): Promise<boolean> {
    const trimmed = text.trim();
    if ((!trimmed && documentIds.length === 0) || replying) {
      return false;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let storedUserMessage: ChatMessage | undefined;
    setAnnouncement("Evianta is replying.");
    setPending({ text: trimmed, documentIds, replyText: "" });
    try {
      const reply = await dataSource.sendMessageAsync(
        caseId,
        { text: trimmed, documentIds },
        {
          signal: controller.signal,
          onUserMessage: (userMessage) => {
            storedUserMessage = userMessage;
            setPending((current) => current && { ...current, userMessage });
          },
          onDelta: (delta) =>
            setPending(
              (current) => current && { ...current, replyText: current.replyText + delta },
            ),
        },
      );
      mutateMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [
          ...current,
          ...[storedUserMessage, reply.message].filter((message): message is ChatMessage =>
            Boolean(message && !known.has(message.id)),
          ),
        ];
      });
      applyCase(reply.case);
      workspace.reload();
      setPending(undefined);
      setAnnouncement("Reply ready.");
      return true;
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      setPending(
        (current) =>
          current && {
            ...current,
            error: cancelled ? "You stopped this reply." : describeError(error),
          },
      );
      setAnnouncement(cancelled ? "Reply stopped." : "The reply failed.");
      reloadMessages();
      return false;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  async function runAsync() {
    const started = await workspace.runAsync();
    reloadMessages();
    return started;
  }

  async function retryRunAsync() {
    const started = await workspace.retryAsync();
    reloadMessages();
    return started;
  }

  return {
    workspace,
    messages: messages.data ?? [],
    messagesLoaded: messages.data !== undefined,
    messagesError: messages.error,
    pending,
    replying,
    announcement,
    sendAsync,
    retryPending: () => {
      const failed = pending;
      if (!failed?.error) {
        return;
      }

      setPending(undefined);
      void sendAsync(failed.text, failed.documentIds);
    },
    dismissPending: () => setPending(undefined),
    stop: () => abortRef.current?.abort(),
    applyCase,
    runAsync,
    retryRunAsync,
    reloadMessages,
  };
}
