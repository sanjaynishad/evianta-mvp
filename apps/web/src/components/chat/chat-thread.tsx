"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  FileUp,
  FolderOpen,
  ListRestart,
  Pencil,
  Plus,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import {
  chatMessageText,
  chatStageOf,
  createCaseIntake,
  useCaseDefinitions,
  type CaseDocument,
  type ChatMessage,
  type ChatPartOfType,
  type DocumentStatus,
  type UpdateCaseRequest,
  type UseCase,
} from "@evianta/core";
import { EvidenceChipList } from "@/components/case/evidence-chip-list";
import { EvidenceDrawer } from "@/components/case/evidence-drawer";
import { FixtureModeNotice } from "@/components/case/fixture-mode-notice";
import { ChatBubble } from "@/components/patterns/chat-bubble";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { BrowseSourceSheet } from "@/components/sources/browse-source-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useLocalReviewNotes } from "@/hooks/use-local-review-notes";
import { useReviewActions } from "@/hooks/use-review-actions";
import { useTryCase } from "@/hooks/use-try-case";
import { trackEvent } from "@/lib/analytics";
import { ApiError, describeError } from "@/lib/api/errors";
import { takePendingFirstMessage } from "@/lib/chat-pending";
import { useDataSource } from "@/lib/data/data-source-context";
import { buildEvidenceIndex, type EvidenceEntry } from "@/lib/evidence";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";
import { sourceOriginLabel } from "@/lib/sources";
import { Composer, type ComposerAttachment, type ComposerAttachmentStatus } from "./composer";
import { IntakeRequestCard, intakeBusyKeys } from "./intake-request-card";
import { ResultCard } from "./result-card";
import { PastRunNote, RunCard } from "./run-card";
import { JumpToLatest, useStickToBottom } from "./stick-to-bottom";
import { SubmitConfirmDialog } from "./submit-confirm-dialog";
import { UseCaseChoiceCard } from "./use-case-choice-card";

const documentAttachmentStatus: Record<DocumentStatus, ComposerAttachmentStatus> = {
  pending: "reading",
  processing: "reading",
  ready: "ready",
  partial: "needs-review",
  failed: "failed",
};

export interface ChatThreadProps {
  caseId: string;
}

function MessageText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap">{text}</p>;
}

function AssistantExtras({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col gap-3 pl-10">{children}</div>;
}

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Evianta is replying">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
          style={{ animationDelay: `${dot * 150}ms` }}
        />
      ))}
    </span>
  );
}

function lastIndexWithPart(messages: ChatMessage[], type: ChatMessage["parts"][number]["type"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.parts.some((part) => part.type === type)) {
      return index;
    }
  }

  return -1;
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="ml-auto h-12 w-1/2" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function ChatThread({ caseId }: ChatThreadProps) {
  const router = useRouter();
  const dataSource = useDataSource();
  const { tryCaseAsync, copyingCaseId } = useTryCase({ openIn: "chat" });
  const thread = useChatThread(caseId, { onTryCase: () => void tryCaseAsync(caseId) });
  const { workspace } = thread;
  const state = workspace.state;
  const localNotes = useLocalReviewNotes(caseId);
  const reviewActions = useReviewActions({
    caseId,
    state,
    mutate: workspace.mutate,
    onTryCase: () => void tryCaseAsync(caseId),
  });
  const [draft, setDraft] = useState("");
  const [stagedIds, setStagedIds] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string>();
  const [browse, setBrowse] = useState<{ itemId?: string }>();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [openEvidenceId, setOpenEvidenceId] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string>();
  const firstMessageTaken = useRef(false);
  const { contentRef, atBottom, scrollToBottom } = useStickToBottom(
    `${thread.messages.length}:${thread.pending?.replyText.length ?? 0}:${workspace.progress?.lastSeq ?? 0}:${state?.deliverables.length ?? 0}`,
  );

  const readOnly = Boolean(state?.case.isSample);
  const runActive = Boolean(state?.run.active || workspace.streaming || workspace.busyAction);
  const stage = state
    ? chatStageOf({
        taskCount: state.tasks.length,
        runActive,
        deliverableCount: state.deliverables.length,
      })
    : "gathering";
  const gathering = stage === "gathering" && !readOnly;
  const intake = state?.case.intake ?? createCaseIntake("chat");

  const evidenceIndex = useMemo(() => {
    const index = state ? buildEvidenceIndex(state) : new Map<string, EvidenceEntry>();
    const documents = new Map(state?.documents.map((document) => [document.id, document]));
    for (const message of thread.messages) {
      for (const part of message.parts) {
        if (part.type !== "answer") {
          continue;
        }

        for (const evidence of part.evidence) {
          if (!index.has(evidence.id)) {
            index.set(evidence.id, {
              evidence,
              document: evidence.documentId ? documents.get(evidence.documentId) : undefined,
              findingIds: [],
            });
          }
        }
      }
    }

    return index;
  }, [state, thread.messages]);
  const findingTitles = useMemo(
    () => new Map(state?.findings.map((finding) => [finding.id, finding.summary])),
    [state?.findings],
  );

  // Sends the first message typed on the chat home once the thread has loaded.
  useEffect(() => {
    if (firstMessageTaken.current || !state || !thread.messagesLoaded) {
      return;
    }

    firstMessageTaken.current = true;
    const pending = takePendingFirstMessage(caseId);
    if (!pending) {
      return;
    }

    void (async () => {
      const uploaded = pending.files.length > 0 ? await workspace.uploadAsync(pending.files) : [];
      await thread.sendAsync(
        pending.text,
        uploaded.map((document) => document.id),
      );
    })();
  }, [caseId, state, thread, workspace]);

  async function runIntakeActionAsync(key: string, actionAsync: () => Promise<void>) {
    setBusyKey(key);
    try {
      await actionAsync();
    } catch (error) {
      toast.error("That did not work", { description: describeError(error) });
    } finally {
      setBusyKey(undefined);
    }
  }

  async function addComposerFilesAsync(files: File[]) {
    const uploaded = await workspace.uploadAsync(files);
    setStagedIds((current) => [...current, ...uploaded.map((document) => document.id)]);
  }

  function uploadForItem(itemId: string, files: File[]) {
    void runIntakeActionAsync(intakeBusyKeys.upload(itemId), async () => {
      const uploaded = await workspace.uploadAsync(files);
      let latest = state?.case;
      for (const document of uploaded) {
        latest = await dataSource.updateIntakeAsync(caseId, {
          assignDocument: { documentId: document.id, itemId },
        });
      }

      if (latest) {
        thread.applyCase(latest);
      }
    });
  }

  function toggleSkip(itemId: string, skipped: boolean) {
    void runIntakeActionAsync(intakeBusyKeys.skip(itemId), async () => {
      thread.applyCase(
        await dataSource.updateIntakeAsync(caseId, { skipItem: { itemId, skipped } }),
      );
    });
  }

  function answerClarification(id: string, answer: string) {
    void runIntakeActionAsync(intakeBusyKeys.clarification(id), async () => {
      thread.applyCase(
        await dataSource.updateIntakeAsync(caseId, { answerClarification: { id, answer } }),
      );
    });
  }

  function actOnProposals(action: "attach" | "dismiss", proposalIds: string[]) {
    void runIntakeActionAsync(intakeBusyKeys.proposals, async () => {
      const response = await dataSource.actOnSourceProposalsAsync(caseId, { action, proposalIds });
      thread.applyCase(response.case);
      if (response.documents.length > 0) {
        trackEvent("source_items_attached", { count: response.documents.length, mode: "chat" });
        workspace.reload();
      }
    });
  }

  function changeEnabledSources(ids: string[]) {
    void runIntakeActionAsync("sources", async () => {
      thread.applyCase(await dataSource.updateIntakeAsync(caseId, { enabledConnectionIds: ids }));
    });
  }

  function chooseUseCase(useCase: UseCase) {
    void runIntakeActionAsync("use-case", async () => {
      thread.applyCase(await dataSource.updateCaseAsync(caseId, { useCase }));
      await thread.sendAsync(`This is ${useCaseDefinitions[useCase].inlineTitle}.`);
    });
  }

  async function confirmSubmitAsync(details: UpdateCaseRequest) {
    setBusyKey("submit");
    try {
      if (details.title !== undefined || details.description !== undefined) {
        thread.applyCase(await dataSource.updateCaseAsync(caseId, details));
      }

      if (!(await thread.runAsync())) {
        return;
      }

      trackEvent("case_submitted", { mode: intake.mode, use_case: state?.case.useCase });
      setSubmitOpen(false);
    } catch (error) {
      toast.error("The work did not start", { description: describeError(error) });
    } finally {
      setBusyKey(undefined);
    }
  }

  async function saveTitleAsync() {
    const title = editingTitle?.trim();
    setEditingTitle(undefined);
    if (!title || title === state?.case.title) {
      return;
    }

    await runIntakeActionAsync("title", async () => {
      thread.applyCase(await dataSource.updateCaseAsync(caseId, { title }));
    });
  }

  function switchToGuidedSetup() {
    void runIntakeActionAsync("switch", async () => {
      await dataSource.updateIntakeAsync(caseId, { mode: "form" });
      trackEvent("intake_mode_switched", { from_mode: "chat", mode: "form" });
      router.push(`/cases/new?caseId=${encodeURIComponent(caseId)}`);
    });
  }

  function send() {
    const text = draft;
    const documentIds = stagedIds;
    setDraft("");
    setStagedIds([]);
    void thread.sendAsync(text, documentIds).then((sent) => {
      if (!sent) {
        setDraft((current) => current || text);
        setStagedIds((current) => (current.length > 0 ? current : documentIds));
      }
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (!gathering || event.dataTransfer.files.length === 0) {
      return;
    }

    event.preventDefault();
    void addComposerFilesAsync([...event.dataTransfer.files]);
  }

  if (!state) {
    if (workspace.error) {
      const notFound = workspace.error instanceof ApiError && workspace.error.status === 404;
      return (
        <EmptyState
          icon={TriangleAlert}
          title={notFound ? "This chat could not be found" : "Could not load this chat"}
          description={
            notFound
              ? "It may have been created in another browser. Start a new chat instead."
              : describeError(workspace.error)
          }
          action={
            <Button asChild variant="outline">
              <Link href="/">New chat</Link>
            </Button>
          }
        />
      );
    }

    return <ThreadSkeleton />;
  }

  const caseItem = state.case;
  const messages = thread.messages;
  const lastIntakeIndex = lastIndexWithPart(messages, "intake-request");
  const lastRunIndex = lastIndexWithPart(messages, "run");
  const lastChoiceIndex = lastIndexWithPart(messages, "use-case-choice");
  const documentsById = new Map(state.documents.map((document) => [document.id, document]));
  const progress = workspace.progress;
  const showResult =
    state.deliverables.length > 0 && !workspace.streaming && progress?.status !== "running";
  const filesDisabledReason = gathering
    ? undefined
    : readOnly
      ? "Sample cases are read-only."
      : "This case is planned. Start a new chat to use different files.";
  const composerDisabledReason =
    stage === "working" ? "Agents are working. Follow along above." : undefined;

  const stagedAttachments: ComposerAttachment[] = [
    ...workspace.uploads.map((upload) => ({
      id: upload.id,
      name: upload.name,
      status: upload.status,
      error: upload.error,
    })),
    ...stagedIds
      .map((id) => documentsById.get(id))
      .filter((document): document is CaseDocument => Boolean(document))
      .map((document) => ({
        id: document.id,
        name: document.name,
        status: documentAttachmentStatus[document.status],
        origin: document.provenance ? sourceOriginLabel(document.provenance) : undefined,
      })),
  ];

  const intakeCard = (
    <IntakeRequestCard
      state={state}
      readOnly={!gathering}
      busyKey={busyKey}
      onUploadForItem={uploadForItem}
      onGetFromSource={(itemId) => setBrowse({ itemId })}
      onToggleSkip={toggleSkip}
      onAnswerClarification={answerClarification}
      onProposals={actOnProposals}
      onSubmit={() => setSubmitOpen(true)}
      submitting={busyKey === "submit"}
    />
  );

  const runCard = progress ? (
    <>
      <RunCard
        progress={progress}
        connection={workspace.connection}
        readOnly={readOnly}
        retrying={workspace.busyAction === "retry"}
        onRetry={() => void thread.retryRunAsync()}
      />
      {showResult ? (
        <ResultCard
          state={state}
          readOnly={readOnly}
          reviewActions={reviewActions}
          localNotes={localNotes}
          onOpenEvidence={setOpenEvidenceId}
        />
      ) : null}
    </>
  ) : null;

  function renderAnswer(part: ChatPartOfType<"answer">, question: string | undefined) {
    return (
      <>
        <EvidenceChipList
          evidenceIds={part.evidenceIds}
          evidenceIndex={evidenceIndex}
          onOpenEvidence={setOpenEvidenceId}
        />
        {part.status === "not-supported" && part.canFlagForReview && question && !readOnly ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              localNotes.addNote({
                text: `Answer needed: ${question}`,
                question,
                severity: "medium",
              });
              toast.success("Added to the open questions in this browser");
            }}
          >
            Flag for review
          </Button>
        ) : null}
      </>
    );
  }

  function renderMessage(message: ChatMessage, index: number) {
    const text = chatMessageText(message);
    if (message.role === "user") {
      const attachments = message.parts.flatMap((part) =>
        part.type === "attachments" ? part.documentIds : [],
      );
      return (
        <ChatBubble key={message.id} role="user" timestamp={message.createdAt}>
          {text ? <MessageText text={text} /> : null}
          {attachments.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Attached files">
              {attachments.map((documentId) => (
                <li
                  key={documentId}
                  className="rounded-full border bg-background px-2 py-0.5 text-xs"
                >
                  {documentsById.get(documentId)?.name ?? "Document"}
                </li>
              ))}
            </ul>
          ) : null}
        </ChatBubble>
      );
    }

    const previousQuestion =
      index > 0 ? chatMessageText(messages[index - 1] as ChatMessage) : undefined;
    const extras: ReactNode[] = [];
    for (const part of message.parts) {
      if (part.type === "use-case-choice" && index === lastChoiceIndex && !caseItem.useCase) {
        extras.push(
          <UseCaseChoiceCard
            key="choice"
            supported={part.supported}
            suggested={part.suggested}
            disabled={!gathering || thread.replying || Boolean(busyKey)}
            onChoose={chooseUseCase}
          />,
        );
      }

      if (part.type === "intake-request" && index === lastIntakeIndex) {
        extras.push(<div key="intake">{intakeCard}</div>);
      }

      if (part.type === "run") {
        extras.push(
          index === lastRunIndex ? (
            <div key="run" className="flex flex-col gap-3">
              {runCard}
            </div>
          ) : (
            <PastRunNote key="run" mode={part.mode} />
          ),
        );
      }

      if (part.type === "answer") {
        extras.push(
          <div key="answer" className="flex flex-col gap-2">
            {renderAnswer(part, previousQuestion)}
          </div>,
        );
      }
    }

    return (
      <div key={message.id} className="flex flex-col gap-2">
        {text ? (
          <ChatBubble
            role="assistant"
            timestamp={message.createdAt}
            citations={
              message.generatedBy === "rules" ? (
                <span className="text-xs text-muted-foreground">
                  {dataSource.mode === "fixtures" ? "Demo reply, no model call" : "Quick reply"}
                </span>
              ) : undefined
            }
          >
            <MessageText text={text} />
          </ChatBubble>
        ) : null}
        {extras.length > 0 ? <AssistantExtras>{extras}</AssistantExtras> : null}
      </div>
    );
  }

  // Samples and cases started before the chat have no transcript, so one is drawn from the case.
  const derived =
    messages.length === 0 && !thread.pending ? (
      <div className="flex flex-col gap-2">
        <ChatBubble role="assistant">
          <MessageText
            text={
              stage === "gathering"
                ? caseItem.useCase
                  ? `Let's prepare ${caseItem.title}. Here is what I need.`
                  : "Tell me about the work you need, or attach your documents."
                : `Here is the work on ${caseItem.title}.`
            }
          />
        </ChatBubble>
        <AssistantExtras>
          {caseItem.useCase ? intakeCard : null}
          {!caseItem.useCase && gathering ? (
            <UseCaseChoiceCard supported disabled={Boolean(busyKey)} onChoose={chooseUseCase} />
          ) : null}
          {stage !== "gathering" ? runCard : null}
        </AssistantExtras>
      </div>
    ) : null;

  const pending = thread.pending;

  return (
    <div
      ref={contentRef}
      className="relative flex min-h-[calc(100dvh-8rem)] flex-col gap-4"
      onDragOver={(event) => {
        if (gathering && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          {editingTitle !== undefined ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTitleAsync();
              }}
            >
              <Input
                aria-label="Case title"
                value={editingTitle}
                maxLength={200}
                autoFocus
                onChange={(event) => setEditingTitle(event.target.value)}
                onBlur={() => void saveTitleAsync()}
                className="h-8 w-72"
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Save title"
              >
                <Check aria-hidden />
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-1">
              <h1 className="truncate text-lg font-semibold">{caseItem.title}</h1>
              {gathering ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Rename the case"
                  onClick={() => setEditingTitle(caseItem.title)}
                >
                  <Pencil aria-hidden className="size-3.5" />
                </Button>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {caseItem.useCase ? (
              <Badge variant="neutral">{useCaseLabels[caseItem.useCase]}</Badge>
            ) : null}
            <StatusBadge status={caseStatusToWorkStatus[caseItem.status]} />
            {readOnly ? <Badge variant="info">Sample</Badge> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {gathering ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={switchToGuidedSetup}
              loading={busyKey === "switch"}
            >
              {busyKey === "switch" ? null : <ListRestart aria-hidden />}
              Switch to guided setup
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href={`/cases/${encodeURIComponent(caseId)}`}>
              <FolderOpen aria-hidden />
              Open workspace
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <Plus aria-hidden />
              New chat
            </Link>
          </Button>
        </div>
      </header>

      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex flex-1 flex-col gap-5"
      >
        {!thread.messagesLoaded && !thread.messagesError ? <ThreadSkeleton /> : null}
        {thread.messagesError ? (
          <p className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle aria-hidden className="size-4" />
            The conversation could not be loaded. {describeError(thread.messagesError)}
            <Button variant="link" size="sm" onClick={thread.reloadMessages}>
              Try again
            </Button>
          </p>
        ) : null}
        {derived}
        {messages.map(renderMessage)}
        {pending && !pending.userMessage ? (
          <ChatBubble role="user">
            {pending.text ? <MessageText text={pending.text} /> : null}
            {pending.documentIds.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {pending.documentIds.length} {pending.documentIds.length === 1 ? "file" : "files"}
              </p>
            ) : null}
          </ChatBubble>
        ) : null}
        {pending?.userMessage && !messages.some((message) => message.id === pending.userMessage?.id)
          ? renderMessage(pending.userMessage, messages.length)
          : null}
        {pending && !pending.error ? (
          <ChatBubble role="assistant">
            {pending.replyText ? <MessageText text={pending.replyText} /> : <TypingIndicator />}
          </ChatBubble>
        ) : null}
        {pending?.error ? (
          <div className="flex flex-wrap items-center gap-2 pl-10 text-sm">
            <AlertCircle aria-hidden className="size-4 text-danger" />
            <span>{pending.error}</span>
            <Button variant="outline" size="sm" onClick={thread.retryPending}>
              <RotateCcw aria-hidden />
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={thread.dismissPending}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {thread.announcement}
      </p>

      <div className="sticky bottom-0 z-10 flex flex-col gap-2 bg-gradient-to-t from-background via-background to-transparent pb-4 pt-6">
        {!atBottom ? (
          <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap">
            <JumpToLatest onClick={scrollToBottom} />
          </div>
        ) : null}
        {readOnly ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-3 shadow-elevation-2">
            <p className="text-sm text-muted-foreground">
              Samples are read-only. Try this case to get your own copy you can chat about.
            </p>
            <Button loading={copyingCaseId === caseId} onClick={() => void tryCaseAsync(caseId)}>
              Try this case
            </Button>
          </div>
        ) : (
          <Composer
            value={draft}
            onValueChange={setDraft}
            onSubmit={send}
            onStop={thread.stop}
            replying={thread.replying}
            placeholder={
              stage === "delivered"
                ? "Ask about the findings, figures, or evidence"
                : "Reply, add details, or attach more files"
            }
            disabledReason={composerDisabledReason}
            attachments={stagedAttachments}
            onAddFiles={(files) => void addComposerFilesAsync(files)}
            onRemoveAttachment={(id) => {
              setStagedIds((current) => current.filter((stagedId) => stagedId !== id));
              workspace.dismissUpload(id);
            }}
            filesDisabledReason={filesDisabledReason}
            enabledConnectionIds={gathering ? intake.enabledConnectionIds : undefined}
            onEnabledConnectionIdsChange={gathering ? changeEnabledSources : undefined}
          />
        )}
      </div>

      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]"
        >
          <div className="flex items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-card px-6 py-4 text-sm font-medium text-primary">
            <FileUp aria-hidden className="size-5" />
            Drop files to attach them
          </div>
        </div>
      ) : null}

      <BrowseSourceSheet
        open={Boolean(browse)}
        onOpenChange={(open) => !open && setBrowse(undefined)}
        caseId={caseId}
        useCase={caseItem.useCase}
        checklistItemId={browse?.itemId}
        onAttached={(response) => {
          thread.applyCase(response.case);
          workspace.reload();
        }}
      />
      <SubmitConfirmDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        state={state}
        submitting={busyKey === "submit"}
        onConfirm={(details) => void confirmSubmitAsync(details)}
      />
      <EvidenceDrawer
        entry={openEvidenceId ? evidenceIndex.get(openEvidenceId) : undefined}
        findingTitles={findingTitles}
        onOpenChange={(open) => !open && setOpenEvidenceId(undefined)}
      />
    </div>
  );
}
