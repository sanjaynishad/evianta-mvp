"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { CircleCheck, CircleDashed, Paperclip, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { uploadAccept, type ChecklistItem } from "@/lib/use-cases";
import { cn } from "@/lib/utils";

export interface IntakeFile {
  id: string;
  file: File;
  itemId?: string;
}

export interface UploadChecklistProps {
  checklist: ChecklistItem[];
  files: IntakeFile[];
  onAddFiles: (files: File[], itemId?: string) => void;
  onRemoveFile: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }

  return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

function FileRow({ entry, onRemove }: { entry: IntakeFile; onRemove: (id: string) => void }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{entry.file.name}</span>
      <span className="figures shrink-0 text-xs text-muted-foreground">
        {formatSize(entry.file.size)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${entry.file.name}`}
        onClick={() => onRemove(entry.id)}
      >
        <X aria-hidden />
      </Button>
    </li>
  );
}

export function UploadChecklist({
  checklist,
  files,
  onAddFiles,
  onRemoveFile,
}: UploadChecklistProps) {
  const generalInputRef = useRef<HTMLInputElement>(null);
  const itemInputRefs = useRef(new Map<string, HTMLInputElement>());
  const [dragging, setDragging] = useState(false);
  const dropHintId = useId();
  const otherFiles = files.filter((entry) => !entry.itemId);
  const attachedCount = checklist.filter((item) =>
    files.some((entry) => entry.itemId === item.id),
  ).length;

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) {
      onAddFiles(dropped);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Documents</p>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {attachedCount} of {checklist.length} checklist items added
        </p>
      </div>
      <ul aria-label="Document checklist" className="flex flex-col divide-y rounded-lg border">
        {checklist.map((item) => {
          const itemFiles = files.filter((entry) => entry.itemId === item.id);
          const done = itemFiles.length > 0;
          return (
            <li
              key={item.id}
              data-checklist-item={item.id}
              data-done={done || undefined}
              className="flex flex-col gap-2 p-3"
            >
              <div className="flex items-start gap-3">
                {done ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleDashed
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.label}</span>
                    {done ? (
                      <Badge variant="success">Added</Badge>
                    ) : (
                      <Badge variant={item.requirement === "recommended" ? "warning" : "neutral"}>
                        {item.requirement === "recommended" ? "Recommended" : "Optional"}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                </div>
                <input
                  ref={(element) => {
                    if (element) {
                      itemInputRefs.current.set(item.id, element);
                    } else {
                      itemInputRefs.current.delete(item.id);
                    }
                  }}
                  type="file"
                  multiple
                  accept={item.accept ?? uploadAccept}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    const selected = Array.from(event.target.files ?? []);
                    if (selected.length > 0) {
                      onAddFiles(selected, item.id);
                    }

                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Add file for ${item.label}`}
                  onClick={() => itemInputRefs.current.get(item.id)?.click()}
                >
                  <Upload aria-hidden />
                  Add
                </Button>
              </div>
              {itemFiles.length > 0 ? (
                <ul className="ml-7 flex flex-col gap-1">
                  {itemFiles.map((entry) => (
                    <FileRow key={entry.id} entry={entry} onRemove={onRemoveFile} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-fast",
          dragging && "border-primary bg-primary-subtle",
        )}
      >
        <Upload aria-hidden className="size-5 text-muted-foreground" />
        <p id={dropHintId} className="text-sm text-muted-foreground">
          Drop any files here, and they are matched to the checklist by name.
        </p>
        <input
          ref={generalInputRef}
          type="file"
          multiple
          accept={uploadAccept}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length > 0) {
              onAddFiles(selected);
            }

            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={dropHintId}
          onClick={() => generalInputRef.current?.click()}
        >
          Choose files
        </Button>
      </div>

      {otherFiles.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Other documents</p>
          <ul className="flex flex-col gap-1">
            {otherFiles.map((entry) => (
              <FileRow key={entry.id} entry={entry} onRemove={onRemoveFile} />
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Missing items never block a run. Anything not provided becomes an open question in the
        results.
      </p>
    </div>
  );
}
