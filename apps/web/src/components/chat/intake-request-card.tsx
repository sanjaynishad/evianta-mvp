"use client";

import { useId, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Database,
  Paperclip,
  Play,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  buildIntakeRequirements,
  createCaseIntake,
  lowerFirstWord,
  pendingSourceProposals,
  sourceConnectorsForChecklistItem,
  summarizeIntakeRequirements,
  type CaseState,
  type IntakeClarification,
  type IntakeRequirement,
} from "@evianta/core";
import { SourceMonogram } from "@/components/sources/source-monogram";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sourceConnectorName, sourceOriginLabel } from "@/lib/sources";
import { cn } from "@/lib/utils";

export interface IntakeRequestCardProps {
  state: CaseState;
  readOnly: boolean;
  busyKey?: string;
  onUploadForItem: (itemId: string, files: File[]) => void;
  onGetFromSource: (itemId: string) => void;
  onToggleSkip: (itemId: string, skipped: boolean) => void;
  onAnswerClarification: (id: string, answer: string) => void;
  onProposals: (action: "attach" | "dismiss", proposalIds: string[]) => void;
  onSubmit: () => void;
  submitting: boolean;
}

export const intakeBusyKeys = {
  skip: (itemId: string) => `skip:${itemId}`,
  upload: (itemId: string) => `upload:${itemId}`,
  proposals: "proposals",
  clarification: (id: string) => `clarification:${id}`,
};

function RequirementStatus({ requirement }: { requirement: IntakeRequirement }) {
  if (requirement.status === "received") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CheckCircle2 aria-hidden className="size-3.5" />
        Received
      </span>
    );
  }

  if (requirement.status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <CircleSlash aria-hidden className="size-3.5" />
        Not available
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
      <CircleDashed aria-hidden className="size-3.5" />
      Missing
    </span>
  );
}

function ClarificationField({
  clarification,
  readOnly,
  saving,
  onSave,
}: {
  clarification: IntakeClarification;
  readOnly: boolean;
  saving: boolean;
  onSave: (answer: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(clarification.answer ?? "");
  const changed = draft.trim() !== (clarification.answer ?? "");

  if (clarification.kind === "choice" && clarification.options?.length) {
    return (
      <fieldset className="flex flex-col gap-1.5" disabled={readOnly || saving}>
        <legend className="text-sm">{clarification.text}</legend>
        <div className="flex flex-wrap gap-1.5">
          {clarification.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={clarification.answer === option ? "default" : "outline"}
              className="rounded-full"
              aria-pressed={clarification.answer === option}
              onClick={() => onSave(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) {
          onSave(draft.trim());
        }
      }}
    >
      <label htmlFor={id} className="text-sm">
        {clarification.text}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={clarification.kind === "date" ? "date" : "text"}
          value={draft}
          maxLength={1000}
          disabled={readOnly}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (changed) {
              onSave(draft.trim());
            }
          }}
          className="h-8"
        />
        {changed && !readOnly ? (
          <Button type="submit" size="sm" variant="outline" loading={saving}>
            Save
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function RequirementRow({
  requirement,
  documentNames,
  readOnly,
  busyKey,
  onUploadForItem,
  onGetFromSource,
  onToggleSkip,
}: {
  requirement: IntakeRequirement;
  documentNames: Map<string, { name: string; origin?: string }>;
} & Pick<
  IntakeRequestCardProps,
  "readOnly" | "busyKey" | "onUploadForItem" | "onGetFromSource" | "onToggleSkip"
>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { item, status } = requirement;
  const suppliers = sourceConnectorsForChecklistItem(item.id);

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {item.label}
            <Badge variant={item.requirement === "recommended" ? "primary" : "neutral"}>
              {item.requirement === "recommended" ? "Recommended" : "Optional"}
            </Badge>
          </span>
          <span className="text-xs text-muted-foreground">{item.hint}</span>
        </div>
        <RequirementStatus requirement={requirement} />
      </div>
      {requirement.documentIds.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {requirement.documentIds.map((documentId) => {
            const document = documentNames.get(documentId);
            return (
              <li
                key={documentId}
                className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
              >
                <Paperclip aria-hidden className="size-3" />
                <span className="max-w-[16rem] truncate">{document?.name ?? "Document"}</span>
                {document?.origin ? (
                  <span className="text-muted-foreground">· {document.origin}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {status !== "skipped" ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={busyKey === intakeBusyKeys.upload(item.id)}
                onClick={() => fileInputRef.current?.click()}
                aria-label={`Upload ${item.label}`}
              >
                {busyKey === intakeBusyKeys.upload(item.id) ? null : <Upload aria-hidden />}
                {status === "received" ? "Add another" : "Upload"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={item.accept}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length > 0) {
                    onUploadForItem(item.id, files);
                  }
                }}
              />
              {suppliers.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onGetFromSource(item.id)}
                  aria-label={`Get ${item.label} from a data source`}
                >
                  <Database aria-hidden />
                  Get from a data source
                  <span aria-hidden className="ml-0.5 flex -space-x-1">
                    {suppliers.slice(0, 3).map((connector) => (
                      <SourceMonogram
                        key={connector.id}
                        connectorId={connector.id}
                        size="sm"
                        className="ring-2 ring-background"
                      />
                    ))}
                  </span>
                </Button>
              ) : null}
            </>
          ) : null}
          {status === "missing" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={busyKey === intakeBusyKeys.skip(item.id)}
              onClick={() => onToggleSkip(item.id, true)}
            >
              I don&apos;t have this
            </Button>
          ) : null}
          {status === "skipped" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={busyKey === intakeBusyKeys.skip(item.id)}
              onClick={() => onToggleSkip(item.id, false)}
            >
              {busyKey === intakeBusyKeys.skip(item.id) ? null : <Undo2 aria-hidden />}
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function IntakeRequestCard({
  state,
  readOnly,
  busyKey,
  onUploadForItem,
  onGetFromSource,
  onToggleSkip,
  onAnswerClarification,
  onProposals,
  onSubmit,
  submitting,
}: IntakeRequestCardProps) {
  const headingId = useId();
  const useCase = state.case.useCase;
  if (!useCase) {
    return null;
  }

  const intake = state.case.intake ?? createCaseIntake("chat");
  const requirements = buildIntakeRequirements(useCase, state.documents, intake);
  const progress = summarizeIntakeRequirements(requirements);
  const proposals = pendingSourceProposals(intake);
  const documentNames = new Map(
    state.documents.map((document) => [
      document.id,
      {
        name: document.name,
        origin: document.provenance ? sourceOriginLabel(document.provenance) : undefined,
      },
    ]),
  );
  const checklistLabels = new Map(requirements.map((entry) => [entry.item.id, entry.item.label]));
  const percent =
    progress.recommendedTotal > 0
      ? Math.round((progress.recommendedReceived / progress.recommendedTotal) * 100)
      : 100;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="intake-card"
      className="flex w-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-elevation-1"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={headingId} className="text-sm font-semibold">
          {readOnly ? "What the work started with" : "To prepare this I need"}
        </h3>
        {!readOnly ? (
          <p className="text-xs text-muted-foreground">
            Upload files, get them from a data source, or tell me what you do not have.
          </p>
        ) : null}
      </div>

      {proposals.length > 0 && !readOnly ? (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary-subtle/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">From your data sources</p>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                loading={busyKey === intakeBusyKeys.proposals}
                onClick={() =>
                  onProposals(
                    "attach",
                    proposals.map((proposal) => proposal.id),
                  )
                }
              >
                Attach all
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex items-center gap-2.5 rounded-md border bg-background p-2"
              >
                <SourceMonogram connectorId={proposal.connectorId} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{proposal.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {sourceConnectorName(proposal.connectorId)}
                    {proposal.detail ? ` · ${proposal.detail}` : ""} · for{" "}
                    {lowerFirstWord(
                      checklistLabels.get(proposal.checklistItemId) ?? proposal.checklistItemId,
                    )}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === intakeBusyKeys.proposals}
                  onClick={() => onProposals("attach", [proposal.id])}
                  aria-label={`Attach ${proposal.label}`}
                >
                  Attach
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={busyKey === intakeBusyKeys.proposals}
                  onClick={() => onProposals("dismiss", [proposal.id])}
                  aria-label={`Dismiss ${proposal.label}`}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="flex flex-col divide-y rounded-lg border">
        {requirements.map((requirement) => (
          <RequirementRow
            key={requirement.item.id}
            requirement={requirement}
            documentNames={documentNames}
            readOnly={readOnly}
            busyKey={busyKey}
            onUploadForItem={onUploadForItem}
            onGetFromSource={onGetFromSource}
            onToggleSkip={onToggleSkip}
          />
        ))}
      </ul>

      {intake.clarifications.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <p className="text-sm font-medium">A few details</p>
          {intake.clarifications.map((clarification) => (
            <ClarificationField
              key={clarification.id}
              clarification={clarification}
              readOnly={readOnly}
              saving={busyKey === intakeBusyKeys.clarification(clarification.id)}
              onSave={(answer) => onAnswerClarification(clarification.id, answer)}
            />
          ))}
        </div>
      ) : null}

      {!readOnly ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              <span className="figures font-medium text-foreground">
                {progress.recommendedReceived} of {progress.recommendedTotal}
              </span>{" "}
              recommended items. Missing items become open questions for your review.
            </p>
            <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-base ease-standard motion-reduce:transition-none"
                style={{ transform: `scaleX(${percent / 100})` }}
              />
            </div>
          </div>
          <Button
            onClick={onSubmit}
            loading={submitting}
            variant={progress.complete ? "default" : "outline"}
            className={cn(progress.complete && "shadow-elevation-2")}
          >
            {submitting ? null : <Play aria-hidden />}
            Submit and start work
          </Button>
        </div>
      ) : null}
    </section>
  );
}
