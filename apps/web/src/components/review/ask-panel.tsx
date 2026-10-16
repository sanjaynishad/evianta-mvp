"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CircleAlert, Flag, FlaskConical, ListPlus, SendHorizontal, Square } from "lucide-react";
import type { AskResult, CaseDocument, UseCase } from "@evianta/core";
import { ChatBubble } from "@/components/patterns/chat-bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LocalReviewNotes } from "@/hooks/use-local-review-notes";
import { genericSuggestedQuestions, suggestedQuestions } from "@/lib/ask";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import type { EvidenceEntry } from "@/lib/evidence";
import { openQuestionsDomId } from "@/lib/review";
import { EvidenceHoverChip } from "./evidence-hover-chip";
import { useReview } from "./review-context";

type AnswerStatus = "streaming" | "answered" | "not-supported" | "error";

interface AskExchange {
  id: string;
  question: string;
  askedAt: string;
  text: string;
  status: AnswerStatus;
  result?: AskResult;
  error?: string;
  flaggedNoteId?: string;
}

export interface AskPanelProps {
  useCase?: UseCase;
  documents: CaseDocument[];
  localNotes: LocalReviewNotes;
}

let exchangeCounter = 0;

function nextExchangeId(): string {
  exchangeCounter += 1;
  return `ask-${exchangeCounter}`;
}

export function AskPanel({ useCase, documents, localNotes }: AskPanelProps) {
  const dataSource = useDataSource();
  const review = useReview();
  const inputId = useId();
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const streaming = exchanges.some((exchange) => exchange.status === "streaming");
  const suggestions = useCase ? suggestedQuestions[useCase] : genericSuggestedQuestions;
  const fixtureMode = dataSource.mode === "fixtures";

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [exchanges]);

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
    setQuestion("");
    setAnnouncement("");
    setExchanges((current) => [
      ...current,
      {
        id,
        question: trimmed,
        askedAt: new Date().toISOString(),
        text: "",
        status: "streaming",
      },
    ]);
    try {
      const result = await dataSource.askAsync(review.caseId, trimmed, {
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
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void askAsync(question);
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

  function citationEntries(result: AskResult): EvidenceEntry[] {
    const fromResult = result.status === "answered" ? result.evidence : [];
    return [...new Set(result.evidenceIds)]
      .map((evidenceId) => {
        const indexed = review.evidenceIndex.get(evidenceId);
        if (indexed) {
          return indexed;
        }

        const evidence = fromResult.find((item) => item.id === evidenceId);
        return evidence
          ? {
              evidence,
              document: documents.find((document) => document.id === evidence.documentId),
              findingIds: [],
            }
          : undefined;
      })
      .filter((entry): entry is EvidenceEntry => entry !== undefined);
  }

  return (
    <section aria-label="Ask about this case" className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">
          Answers come only from this case&apos;s findings, evidence, and documents, with the
          sources cited.
        </p>
        {fixtureMode ? (
          <p
            role="note"
            className="flex items-start gap-1.5 rounded-md border border-dashed border-info/40 bg-info-subtle px-2 py-1.5 text-xs text-info"
          >
            <FlaskConical aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            Sample answers: in fixture mode, Ask retrieves from the recorded sample work record and
            replies with prepared answers. No model is called.
          </p>
        ) : null}
      </div>

      <div
        ref={listRef}
        role="log"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {exchanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ask anything about the work record, or start with a suggestion below.
          </p>
        ) : null}
        {exchanges.map((exchange) => {
          const result = exchange.result;
          const citations = result ? citationEntries(result) : [];
          const findingIds = result
            ? result.findingIds.length > 0
              ? result.findingIds
              : result.retrievedFindingIds
            : [];
          const findings = findingIds
            .map((findingId) => review.findingsById.get(findingId))
            .filter((finding) => finding !== undefined);
          return (
            <div key={exchange.id} className="flex flex-col gap-3" data-ask-exchange={exchange.id}>
              <ChatBubble role="user" timestamp={exchange.askedAt}>
                {exchange.question}
              </ChatBubble>
              <ChatBubble
                role="assistant"
                citations={
                  citations.length > 0
                    ? citations.map((entry) => (
                        <EvidenceHoverChip
                          key={entry.evidence.id}
                          entry={entry}
                          onOpen={review.openEvidence}
                          selected={review.isEvidenceHighlighted(entry.evidence.id)}
                        />
                      ))
                    : undefined
                }
              >
                <div
                  className="flex flex-col gap-2"
                  data-answer-status={exchange.status}
                  aria-busy={exchange.status === "streaming" || undefined}
                >
                  {exchange.status === "not-supported" ? (
                    <p className="flex items-start gap-1.5">
                      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                      <span>{exchange.text}</span>
                    </p>
                  ) : exchange.status === "error" ? (
                    <p className="flex items-start gap-1.5 text-danger">
                      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>{exchange.error}</span>
                    </p>
                  ) : (
                    <p className="whitespace-pre-line" data-testid="answer-text">
                      {exchange.text}
                      {exchange.status === "streaming" ? (
                        <span
                          aria-hidden
                          className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-text-bottom motion-reduce:animate-none"
                        />
                      ) : null}
                    </p>
                  )}
                  {exchange.status === "streaming" && !exchange.text ? (
                    <span className="text-xs text-muted-foreground">
                      Looking through the work record
                    </span>
                  ) : null}
                  {findings.length > 0 ? (
                    <div className="flex flex-col gap-1 border-t pt-2">
                      <p className="text-xs font-medium text-muted-foreground">Findings used</p>
                      <ul aria-label="Findings used" className="flex flex-col gap-1">
                        {findings.map((finding) => (
                          <li key={finding.id}>
                            <button
                              type="button"
                              onClick={() => review.focusFinding(finding.id)}
                              className="rounded-sm text-left text-xs underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {finding.summary}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {exchange.status === "not-supported" &&
                  result?.status === "not-supported" &&
                  result.canFlagForReview ? (
                    exchange.flaggedNoteId ? (
                      <p className="text-xs text-success">
                        Flagged. It is in{" "}
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          onClick={() => review.focusElement(openQuestionsDomId)}
                        >
                          Open questions
                        </button>{" "}
                        as a note saved in this browser.
                      </p>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={() => flagForReview(exchange)}
                      >
                        <Flag aria-hidden />
                        Flag for review
                      </Button>
                    )
                  ) : null}
                  {exchange.status === "answered" ? (
                    exchange.flaggedNoteId ? (
                      <Badge variant="success" className="w-fit">
                        Added to open questions
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-fit"
                        onClick={() => flagForReview(exchange)}
                      >
                        <ListPlus aria-hidden />
                        Add as open question
                      </Button>
                    )
                  ) : null}
                </div>
              </ChatBubble>
            </div>
          );
        })}
      </div>

      <p className="sr-only" aria-live="polite" data-testid="ask-announcer">
        {announcement}
      </p>

      <div className="flex flex-col gap-2 border-t pt-3">
        <ul aria-label="Suggested questions" className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <Button
                size="sm"
                variant="outline"
                className="h-auto whitespace-normal py-1 text-left"
                disabled={streaming}
                onClick={() => void askAsync(suggestion)}
              >
                {suggestion}
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
            Ask a question about this case
          </label>
          <Textarea
            id={inputId}
            rows={2}
            value={question}
            placeholder="For example: which invoices are unpaid?"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void askAsync(question);
              }
            }}
          />
          <div className="flex justify-end gap-2">
            {streaming ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => abortRef.current?.abort()}
              >
                <Square aria-hidden />
                Stop
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={streaming || question.trim().length === 0}>
              <SendHorizontal aria-hidden />
              Ask
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
