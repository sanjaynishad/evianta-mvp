"use client";

import { useEffect, useId, useRef, type FormEvent } from "react";
import { CircleAlert, Flag, FlaskConical, ListPlus, SendHorizontal, Square } from "lucide-react";
import type { AskResult, CaseDocument, UseCase } from "@evianta/core";
import { ChatBubble } from "@/components/patterns/chat-bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AskConversation } from "@/hooks/use-ask-conversation";
import { genericSuggestedQuestions, suggestedQuestions } from "@/lib/ask";
import { useDataSource } from "@/lib/data/data-source-context";
import type { EvidenceEntry } from "@/lib/evidence";
import { openQuestionsDomId } from "@/lib/review";
import { EvidenceHoverChip } from "./evidence-hover-chip";
import { useReview } from "./review-context";

export interface AskPanelProps {
  useCase?: UseCase;
  documents: CaseDocument[];
  conversation: AskConversation;
}

export function AskPanel({ useCase, documents, conversation }: AskPanelProps) {
  const dataSource = useDataSource();
  const review = useReview();
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const {
    exchanges,
    draft: question,
    setDraft: setQuestion,
    announcement,
    streaming,
  } = conversation;
  const suggestions = useCase ? suggestedQuestions[useCase] : genericSuggestedQuestions;
  const fixtureMode = dataSource.mode === "fixtures";
  const askAsync = conversation.askAsync;
  const flagForReview = conversation.flagForReview;

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [exchanges]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void askAsync(question);
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

      <div ref={listRef} className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {exchanges.length === 0
              ? "Ask anything about the work record, or start with a suggestion."
              : "Suggested questions"}
          </p>
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
        </div>
        <div role="log" aria-label="Conversation" className="flex flex-col gap-4">
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
              <div
                key={exchange.id}
                className="flex flex-col gap-3"
                data-ask-exchange={exchange.id}
              >
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
      </div>

      <p className="sr-only" aria-live="polite" data-testid="ask-announcer">
        {announcement}
      </p>

      <div className="flex flex-col gap-2 border-t pt-3">
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
              <Button type="button" variant="ghost" size="sm" onClick={conversation.stop}>
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
