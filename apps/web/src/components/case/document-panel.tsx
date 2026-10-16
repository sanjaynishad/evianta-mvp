"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { FileText, ShieldAlert, Upload, X } from "lucide-react";
import type { CaseDocument } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import type { LocalUpload } from "@/hooks/use-case-workspace";
import { useAutoAnimateList } from "@/hooks/use-auto-animate-list";
import { formatNumber } from "@/lib/format";
import { extractionMethodLabels } from "@/lib/labels";
import { uploadAccept } from "@/lib/use-cases";
import { cn } from "@/lib/utils";
import { DocumentStatusBadge, HandwritingBadge } from "./document-status";

export interface DocumentPanelProps {
  documents: CaseDocument[];
  uploads: LocalUpload[];
  readOnly: boolean;
  onUpload: (files: File[]) => void;
  onDismissUpload: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }

  return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

export function DocumentPanel({
  documents,
  uploads,
  readOnly,
  onUpload,
  onDismissUpload,
}: DocumentPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const noteId = useId();
  const listRef = useAutoAnimateList<HTMLUListElement>();

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) {
      onUpload(dropped);
    }
  }

  const empty = documents.length === 0 && uploads.length === 0;

  return (
    <section aria-labelledby="documents-heading" className="flex flex-col gap-3 print:hidden">
      <h2 id="documents-heading" className="text-base font-semibold">
        Documents
      </h2>
      {readOnly ? null : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-colors duration-fast",
            dragging && "border-primary bg-primary-subtle",
          )}
        >
          <Upload aria-hidden className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Drag files here or choose them.</p>
          <p id={noteId} className="flex items-center gap-1.5 text-xs text-warning">
            <ShieldAlert aria-hidden className="size-3.5" />
            Use synthetic or anonymised data only.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={uploadAccept}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              if (selected.length > 0) {
                onUpload(selected);
              }

              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={noteId}
            onClick={() => inputRef.current?.click()}
          >
            Upload documents
          </Button>
        </div>
      )}
      {empty ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description={
            readOnly
              ? "This sample has no documents."
              : "A run can start without documents; missing evidence becomes open questions."
          }
        />
      ) : (
        <ul ref={listRef} className="flex flex-col divide-y rounded-lg border bg-card">
          {uploads.map((upload) => (
            <li key={upload.id} className="flex flex-col gap-1.5 p-3" data-upload={upload.status}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{upload.name}</span>
                {upload.status === "failed" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Dismiss ${upload.name}`}
                    onClick={() => onDismissUpload(upload.id)}
                  >
                    <X aria-hidden />
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <DocumentStatusBadge status={upload.status === "failed" ? "failed" : "uploading"} />
                <span className="figures text-xs text-muted-foreground">
                  {formatSize(upload.size)}
                </span>
              </div>
              {upload.error ? <p className="text-xs text-danger">{upload.error}</p> : null}
            </li>
          ))}
          {documents.map((document) => {
            const extraction = document.extraction;
            const reviewPages = extraction?.pagesNeedingReview ?? [];
            return (
              <li
                key={document.id}
                className="flex flex-col gap-1.5 p-3"
                data-document-id={document.id}
              >
                <span className="truncate text-sm font-medium">{document.name}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <DocumentStatusBadge status={document.status} />
                  {extraction?.handwriting ? <HandwritingBadge /> : null}
                  <span className="figures text-xs text-muted-foreground">
                    {formatSize(document.size)}
                  </span>
                </div>
                {extraction ? (
                  <p className="text-xs text-muted-foreground">
                    {extractionMethodLabels[extraction.method]}
                  </p>
                ) : null}
                {reviewPages.length > 0 ? (
                  <p className="text-xs text-warning">
                    {reviewPages.length === 1 ? "Page" : "Pages"} {reviewPages.join(", ")} need
                    review.
                  </p>
                ) : null}
                {document.error ? <p className="text-xs text-danger">{document.error}</p> : null}
                {extraction?.warnings.map((warning) => (
                  <p key={warning} className="text-xs text-warning">
                    {warning}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
