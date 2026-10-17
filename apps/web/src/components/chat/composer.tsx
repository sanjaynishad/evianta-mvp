"use client";

import { useId, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  FileUp,
  Loader2,
  Paperclip,
  Plus,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { uploadAccept } from "@evianta/core";
import { SourcesMenu } from "@/components/sources/sources-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// "queued" files are held locally until the first message creates the case.
export type ComposerAttachmentStatus =
  "queued" | "uploading" | "reading" | "ready" | "needs-review" | "failed";

export interface ComposerAttachment {
  id: string;
  name: string;
  status: ComposerAttachmentStatus;
  // Where an item came from, for example "From Tally".
  origin?: string;
  error?: string;
}

const maxTextareaHeight = 240;

const statusLabels: Record<ComposerAttachmentStatus, string> = {
  queued: "Attached",
  uploading: "Uploading",
  reading: "Reading",
  ready: "Ready",
  "needs-review": "Check pages",
  failed: "Failed",
};

function AttachmentStatusIcon({ status }: { status: ComposerAttachmentStatus }) {
  if (status === "uploading" || status === "reading") {
    return <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />;
  }

  if (status === "failed") {
    return <AlertCircle aria-hidden className="size-3.5 text-danger" />;
  }

  if (status === "needs-review") {
    return <TriangleAlert aria-hidden className="size-3.5 text-warning" />;
  }

  if (status === "queued") {
    return <Paperclip aria-hidden className="size-3.5 text-muted-foreground" />;
  }

  return <CheckCircle2 aria-hidden className="size-3.5 text-success" />;
}

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          title={attachment.error}
          className={cn(
            "flex max-w-full items-center gap-1.5 rounded-full border bg-background py-0.5 pl-2 pr-1 text-xs",
            attachment.status === "failed" && "border-danger/40",
          )}
        >
          <AttachmentStatusIcon status={attachment.status} />
          <span className="max-w-[14rem] truncate font-medium">{attachment.name}</span>
          <span className="text-muted-foreground">
            {attachment.origin ? `${attachment.origin} · ` : ""}
            {statusLabels[attachment.status]}
          </span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${attachment.name}`}
            >
              <X aria-hidden className="size-3" />
            </button>
          ) : (
            <span className="w-1" />
          )}
        </li>
      ))}
    </ul>
  );
}

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  replying?: boolean;
  busy?: boolean;
  placeholder?: string;
  // Explains why the composer is read-only, for example while agents are working.
  disabledReason?: string;
  attachments?: ComposerAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  filesDisabledReason?: string;
  enabledConnectionIds?: string[];
  onEnabledConnectionIdsChange?: (ids: string[]) => void;
  variant?: "hero" | "docked";
  autoFocus?: boolean;
  label?: string;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  replying = false,
  busy = false,
  placeholder = "Describe the work, or attach your documents",
  disabledReason,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  filesDisabledReason,
  enabledConnectionIds,
  onEnabledConnectionIdsChange,
  variant = "docked",
  autoFocus,
  label = "Message Evianta",
}: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = Boolean(disabledReason);
  const filesDisabled = disabled || Boolean(filesDisabledReason) || !onAddFiles;
  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const canSend =
    !disabled && !busy && !uploading && (value.trim().length > 0 || attachments.length > 0);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxTextareaHeight)}px`;
  }, [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend && !replying) {
        onSubmit();
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (files.length > 0 && !filesDisabled) {
      event.preventDefault();
      onAddFiles?.(files);
    }
  }

  return (
    <div
      data-slot="composer"
      className={cn(
        "flex w-full flex-col gap-2 rounded-2xl border bg-card p-3 shadow-elevation-2 transition-[border-color,box-shadow] duration-fast ease-standard focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/30",
        variant === "hero" && "p-4",
        disabled && "bg-muted/40",
      )}
    >
      <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={inputId}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={disabledReason ?? placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={variant === "hero" ? 3 : 1}
        maxLength={4000}
        aria-describedby={hintId}
        className={cn(
          "max-h-60 min-h-10 w-full resize-none bg-transparent px-1 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed",
          variant === "hero" && "min-h-20 text-base",
        )}
      />
      <span id={hintId} className="sr-only">
        Press Enter to send and Shift plus Enter for a new line.
      </span>
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={filesDisabled}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              aria-label="Add files"
              title={filesDisabledReason}
            >
              <Plus aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
              <FileUp aria-hidden />
              Upload files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {enabledConnectionIds && onEnabledConnectionIdsChange ? (
          <SourcesMenu
            enabledConnectionIds={enabledConnectionIds}
            onEnabledConnectionIdsChange={onEnabledConnectionIdsChange}
            disabled={disabled}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={filesDisabled}
          title={filesDisabledReason}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp aria-hidden />
          Files
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={uploadAccept}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) {
              onAddFiles?.(files);
            }
          }}
        />
        <div className="ml-auto">
          {replying && onStop ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-9 rounded-full"
              onClick={onStop}
              aria-label="Stop the reply"
            >
              <Square aria-hidden className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="size-9 rounded-full"
              disabled={!canSend || replying}
              loading={busy}
              onClick={onSubmit}
              aria-label="Send"
            >
              {busy ? null : <ArrowUp aria-hidden />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
