"use client";

import { useState, type DragEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ClipboardList, Copy, FileUp, FolderOpen } from "lucide-react";
import {
  partitionUploadFiles,
  unsupportedUploadMessage,
  untitledChatTitle,
  useCaseDefinitions,
  useCaseOrder,
} from "@evianta/core";
import { FixtureModeNotice } from "@/components/case/fixture-mode-notice";
import { EviantaLogomark } from "@/components/brand/logomark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useResource } from "@/hooks/use-resource";
import { useTryCase } from "@/hooks/use-try-case";
import { trackEvent } from "@/lib/analytics";
import { describeError } from "@/lib/api/errors";
import { setPendingFirstMessage } from "@/lib/chat-pending";
import { useDataSource } from "@/lib/data/data-source-context";
import { useCaseLabels } from "@/lib/labels";
import { Composer, type ComposerAttachment } from "./composer";
import { useCaseIcons } from "./use-case-choice-card";

let queuedFileCounter = 0;

interface QueuedFile {
  id: string;
  file: File;
}

export function ChatHome() {
  const router = useRouter();
  const dataSource = useDataSource();
  const samples = useResource("samples", () => dataSource.listSamplesAsync());
  const { tryCaseAsync, copyingCaseId } = useTryCase({ openIn: "chat" });
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [enabledConnectionIds, setEnabledConnectionIds] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [dragging, setDragging] = useState(false);

  function addFiles(selected: File[]) {
    const { supported, unsupported } = partitionUploadFiles(selected);
    if (unsupported.length > 0) {
      toast.error(`Skipped ${unsupported.map((file) => file.name).join(", ")}`, {
        description: unsupportedUploadMessage,
      });
    }

    setFiles((current) => [
      ...current,
      ...supported.map((file) => {
        queuedFileCounter += 1;
        return { id: `queued-${queuedFileCounter}`, file };
      }),
    ]);
  }

  async function startAsync() {
    const text = draft.trim();
    if ((!text && files.length === 0) || starting) {
      return;
    }

    setStarting(true);
    try {
      const created = await dataSource.createCaseAsync({
        title: untitledChatTitle,
        intakeMode: "chat",
      });
      if (enabledConnectionIds.length > 0) {
        await dataSource.updateIntakeAsync(created.id, { enabledConnectionIds });
      }

      setPendingFirstMessage(created.id, { text, files: files.map((entry) => entry.file) });
      trackEvent("intake_started", { mode: "chat" });
      router.push(`/chat/${encodeURIComponent(created.id)}`);
    } catch (error) {
      toast.error("Could not start the chat", { description: describeError(error) });
      setStarting(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (event.dataTransfer.files.length === 0) {
      return;
    }

    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  }

  const attachments: ComposerAttachment[] = files.map((entry) => ({
    id: entry.id,
    name: entry.file.name,
    status: "queued",
  }));

  return (
    <div
      className="relative flex min-h-[calc(100dvh-8rem)] flex-col items-center gap-10 pb-10 pt-[8vh]"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
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
      {dataSource.mode === "fixtures" ? (
        <div className="w-full max-w-3xl">
          <FixtureModeNotice />
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-3 text-center">
        <EviantaLogomark className="size-10" />
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          What are we working on?
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
          Describe the work and attach what you have. Evianta asks for anything missing, then a team
          of specialists prepares it with evidence you can check.
        </p>
      </div>

      <div className="flex w-full max-w-3xl flex-col gap-3">
        <Composer
          variant="hero"
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => void startAsync()}
          busy={starting}
          autoFocus
          attachments={attachments}
          onAddFiles={addFiles}
          onRemoveAttachment={(id) =>
            setFiles((current) => current.filter((entry) => entry.id !== id))
          }
          enabledConnectionIds={enabledConnectionIds}
          onEnabledConnectionIdsChange={setEnabledConnectionIds}
          placeholder="For example: reply to my 143(1) intimation about a TDS mismatch"
        />
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Starting points">
          {useCaseOrder.map((useCase) => {
            const Icon = useCaseIcons[useCase];
            return (
              <li key={useCase}>
                <button
                  type="button"
                  onClick={() => setDraft(useCaseDefinitions[useCase].starterPrompt)}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-standard hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon aria-hidden className="size-3.5 text-primary" />
                  {useCaseDefinitions[useCase].title}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Use synthetic or anonymised documents only. This demo is public.</span>
          <Link
            href="/cases/new"
            onClick={() => trackEvent("intake_started", { mode: "form" })}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            <ClipboardList aria-hidden className="size-3.5" />
            Prefer a form? Use guided setup
          </Link>
        </div>
      </div>

      <section aria-labelledby="samples-heading" className="flex w-full max-w-5xl flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <h2 id="samples-heading" className="text-sm font-semibold">
            Explore finished work
          </h2>
          <Link
            href="/cases"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            All cases
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        {!samples.data ? (
          <div className="grid gap-3 sm:grid-cols-3" aria-hidden>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-3">
            {samples.data.map((sample) => (
              <li
                key={sample.id}
                className="flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-elevation-1"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {sample.useCase ? (
                    <Badge variant="neutral">{useCaseLabels[sample.useCase]}</Badge>
                  ) : null}
                  <Badge variant="info">Sample</Badge>
                </div>
                <p className="line-clamp-2 text-sm font-medium">{sample.title}</p>
                <div className="mt-auto flex flex-wrap gap-1.5">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/chat/${encodeURIComponent(sample.id)}`}
                      aria-label={`Open ${sample.title}`}
                    >
                      <FolderOpen aria-hidden />
                      Open
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={copyingCaseId === sample.id}
                    onClick={() => void tryCaseAsync(sample.id)}
                    aria-label={`Try ${sample.title}`}
                  >
                    {copyingCaseId === sample.id ? null : <Copy aria-hidden />}
                    Try this case
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {samples.error ? (
          <p className="text-sm text-muted-foreground">
            Samples could not be loaded. {describeError(samples.error)}
          </p>
        ) : null}
      </section>

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
    </div>
  );
}
