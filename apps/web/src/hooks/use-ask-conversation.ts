"use client";

import { useEffect, useRef, useState } from "react";
import type { AskResult } from "@evianta/core";
import type { LocalReviewNotes } from "@/hooks/use-local-review-notes";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";

export type AnswerStatus = "streaming" | "answered" | "not-supported" | "error";

export interface AskExchange {
  id: string;
  question: string;
  askedAt: string;
  text: string;
  status: AnswerStatus;
  result?: AskResult;
  error?: string;
  flaggedNoteId?: string;
}

export interface AskConversation {
  exchanges: AskExchange[];
  draft: string;
  setDraft: (draft: string) => void;
  announcement: string;
  streaming: boolean;
  askAsync: (question: string) => Promise<void>;
  stop: () => void;
  flagForReview: (exchange: AskExchange) => void;
}

export interface AskConversationOptions {
  caseId: string;
  localNotes: LocalReviewNotes;
  // Called after every request settles, so the case can pick up the usage the API recorded.
  onSettled?: () => void;
}

let exchangeCounter = 0;

function nextExchangeId(): string {
  exchangeCounter += 1;
  return `ask-${exchangeCounter}`;
}

// Held by the workspace rather than the Ask panel, so the conversation and any answer in flight
// survive the panel unmounting (for example when its sheet closes on small screens).
export function useAskConversation({
  caseId,
  localNotes,
  onSettled,
}: AskConversationOptions): AskConversation {
  const dataSource = useDataSource();
  const [draft, setDraft] = useState("");
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const streaming = exchanges.some((exchange) => exchange.status === "streaming");

  useEffect(() => () => abortRef.current?.abort(), []);

  function update(id: string, change: (exchange: AskExchange) => AskExchange) {
    setExchanges((current) =>
      current.map((exchange) => (exchange.id === id ? change(exchange) : exchange)),
    );
  }

  async function askAsync(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) {
      return;
    }

    const id = nextExchangeId();
    const controller = new AbortController();
    abortRef.current = controller;
    setDraft("");
    setAnnouncement("");
    setExchanges((current) => [
      ...current,
      { id, question: trimmed, askedAt: new Date().toISOString(), text: "", status: "streaming" },
    ]);
    try {
      const result = await dataSource.askAsync(caseId, trimmed, {
        signal: controller.signal,
        onDelta: (delta) =>
          update(id, (exchange) => ({ ...exchange, text: exchange.text + delta })),
      });
      update(id, (exchange) => ({
        ...exchange,
        result,
        status: result.status,
        text: result.status === "answered" ? result.answer : result.message,
      }));
      setAnnouncement(
        result.status === "answered"
          ? `Answer ready, citing ${result.evidenceIds.length} sources.`
          : "The work record does not support an answer to this question.",
      );
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      update(id, (exchange) => ({
        ...exchange,
        status: "error",
        error: cancelled ? "You stopped this answer." : describeError(error),
      }));
      setAnnouncement(cancelled ? "Answer stopped." : "The answer failed.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }

      // Failed and stopped requests can still be billed, so reconcile usage after every outcome.
      onSettled?.();
    }
  }

  function flagForReview(exchange: AskExchange) {
    const note = localNotes.addNote({
      text: `Answer needed: ${exchange.question}`,
      question: exchange.question,
      severity: "medium",
    });
    update(exchange.id, (current) => ({ ...current, flaggedNoteId: note.id }));
    setAnnouncement("Added to the open questions as a note in this browser.");
  }

  return {
    exchanges,
    draft,
    setDraft,
    announcement,
    streaming,
    askAsync,
    stop: () => abortRef.current?.abort(),
    flagForReview,
  };
}
