"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageSquare, Play } from "lucide-react";
import { assignDocumentsToChecklist, createCaseIntake, type UseCase } from "@evianta/core";
import { FixtureModeNotice } from "@/components/case/fixture-mode-notice";
import { BrowseSourceSheet } from "@/components/sources/browse-source-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { useResource } from "@/hooks/use-resource";
import { trackEvent } from "@/lib/analytics";
import { describeError } from "@/lib/api/errors";
import { retryWhileUploadingAsync } from "@/lib/api/upload-conflict";
import { useDataSource } from "@/lib/data/data-source-context";
import { sourceOriginLabel } from "@/lib/sources";
import {
  matchChecklistItem,
  partitionUploadFiles,
  unsupportedUploadMessage,
  useCaseDefinitions,
} from "@/lib/use-cases";
import { UploadChecklist, type AttachedDocument, type IntakeFile } from "./upload-checklist";
import { UseCasePicker } from "./use-case-picker";

let intakeFileCounter = 0;

function StepHeading({ step, title, id }: { step: number; title: string; id: string }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
      <span
        aria-hidden
        className="figures flex size-6 items-center justify-center rounded-full bg-primary-subtle text-xs text-primary"
      >
        {step}
      </span>
      <span>
        <span className="sr-only">Step {step}: </span>
        {title}
      </span>
    </h2>
  );
}

export function IntakeView() {
  const dataSource = useDataSource();
  const router = useRouter();
  const searchParams = useSearchParams();
  const formId = useId();
  const [draftId, setDraftId] = useState<string | undefined>(
    () => searchParams.get("caseId") ?? undefined,
  );
  const draft = useResource(draftId ? `case:${draftId}` : null, () =>
    dataSource.getCaseStateAsync(draftId ?? ""),
  );
  const [prefilledFrom, setPrefilledFrom] = useState<string>();
  const [useCase, setUseCase] = useState<UseCase>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [detailsEdited, setDetailsEdited] = useState(false);
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [submitting, setSubmitting] = useState<"create" | "run" | "chat" | "draft">();
  const [statusMessage, setStatusMessage] = useState("");
  const [titleError, setTitleError] = useState<string>();
  const [browseItemId, setBrowseItemId] = useState<string>();
  const definition = useCase ? useCaseDefinitions[useCase] : undefined;
  const locked = Boolean(submitting);

  // A draft started in the chat or by an earlier visit fills the form once it loads.
  const draftCase = draft.data?.case;
  if (draftCase && prefilledFrom !== draftCase.id) {
    setPrefilledFrom(draftCase.id);
    if (draftCase.useCase) {
      setUseCase(draftCase.useCase);
    }

    if (draftCase.title && draftCase.useCase) {
      setTitle(draftCase.title);
      setDescription(draftCase.description ?? "");
      setDetailsEdited(true);
    }
  }

  const attachedDocuments = useMemo<AttachedDocument[]>(() => {
    const state = draft.data;
    if (!state) {
      return [];
    }

    const itemByDocument = new Map<string, string>();
    if (useCase) {
      const assigned = assignDocumentsToChecklist(
        useCase,
        state.documents,
        state.case.intake ?? createCaseIntake("form"),
      );
      for (const [itemId, documentIds] of assigned) {
        for (const documentId of documentIds) {
          itemByDocument.set(documentId, itemId);
        }
      }
    }

    return state.documents.map((document) => ({
      id: document.id,
      name: document.name,
      itemId: itemByDocument.get(document.id),
      origin: document.provenance ? sourceOriginLabel(document.provenance) : undefined,
    }));
  }, [draft.data, useCase]);

  function handleUseCaseChange(next: UseCase) {
    if (locked) {
      return;
    }

    setUseCase(next);
    if (!detailsEdited) {
      setTitle(useCaseDefinitions[next].exampleTitle);
      setDescription(useCaseDefinitions[next].exampleDescription);
    }

    const checklist = useCaseDefinitions[next].checklist;
    setFiles((current) =>
      current.map((entry) => ({
        ...entry,
        itemId: matchChecklistItem(entry.file.name, checklist)?.id,
      })),
    );
  }

  function handleAddFiles(selected: File[], itemId?: string) {
    if (locked) {
      return;
    }

    const { supported: added, unsupported } = partitionUploadFiles(selected);
    if (unsupported.length > 0) {
      toast.error(`Skipped ${unsupported.map((file) => file.name).join(", ")}`, {
        description: unsupportedUploadMessage,
      });
    }

    const checklist = definition?.checklist ?? [];
    setFiles((current) => [
      ...current,
      ...added.map((file) => {
        intakeFileCounter += 1;
        return {
          id: `intake-file-${intakeFileCounter}`,
          file,
          itemId: itemId ?? matchChecklistItem(file.name, checklist)?.id,
        };
      }),
    ]);
  }

  function handleRemoveFile(id: string) {
    if (locked) {
      return;
    }

    setFiles((current) => current.filter((entry) => entry.id !== id));
  }

  // Saves the form into a draft case: created on first need, updated afterwards.
  async function saveDraftAsync(): Promise<string> {
    if (!useCase) {
      throw new Error("Choose the kind of work first.");
    }

    const details = {
      title: title.trim() || useCaseDefinitions[useCase].exampleTitle,
      description: description.trim() || undefined,
      useCase,
    };
    if (draftId) {
      await dataSource.updateCaseAsync(draftId, details);
      return draftId;
    }

    const created = await dataSource.createCaseAsync({ ...details, intakeMode: "form" });
    setDraftId(created.id);
    router.replace(`/cases/new?caseId=${encodeURIComponent(created.id)}`, { scroll: false });
    return created.id;
  }

  // Uploads the files picked in the form and records which checklist item each one fills.
  async function uploadLocalFilesAsync(caseId: string): Promise<string[]> {
    const failed: string[] = [];
    for (const [index, entry] of files.entries()) {
      setStatusMessage(`Uploading ${index + 1} of ${files.length}: ${entry.file.name}`);
      try {
        const document = await dataSource.uploadDocumentAsync(caseId, entry.file);
        if (entry.itemId) {
          await dataSource.updateIntakeAsync(caseId, {
            assignDocument: { documentId: document.id, itemId: entry.itemId },
          });
        }
      } catch {
        failed.push(entry.file.name);
      }
    }

    setFiles([]);
    return failed;
  }

  async function openDataSourceAsync(itemId: string) {
    if (locked) {
      return;
    }

    setSubmitting("draft");
    try {
      await saveDraftAsync();
      setBrowseItemId(itemId);
    } catch (error) {
      toast.error("Could not prepare the case", { description: describeError(error) });
    } finally {
      setSubmitting(undefined);
    }
  }

  async function switchToChatAsync() {
    if (locked) {
      return;
    }

    if (!useCase && !draftId) {
      trackEvent("intake_mode_switched", { from_mode: "form", mode: "chat" });
      router.push("/");
      return;
    }

    setSubmitting("chat");
    try {
      const caseId = useCase ? await saveDraftAsync() : (draftId ?? "");
      await uploadLocalFilesAsync(caseId);
      await dataSource.updateIntakeAsync(caseId, { mode: "chat" });
      trackEvent("intake_mode_switched", { from_mode: "form", mode: "chat", use_case: useCase });
      router.push(`/chat/${encodeURIComponent(caseId)}`);
    } catch (error) {
      toast.error("Could not open the chat", { description: describeError(error) });
      setSubmitting(undefined);
      setStatusMessage("");
    }
  }

  async function submitAsync(runAfterCreate: boolean) {
    if (!useCase || locked) {
      return;
    }

    if (!title.trim()) {
      setTitleError("Give the case a title.");
      return;
    }

    setTitleError(undefined);
    setSubmitting(runAfterCreate ? "run" : "create");
    try {
      setStatusMessage(draftId ? "Saving the case" : "Creating the case");
      const caseId = await saveDraftAsync();
      const failedUploads = await uploadLocalFilesAsync(caseId);
      const uploadsFailed = failedUploads.length > 0;
      if (uploadsFailed) {
        toast.error("Some files did not upload", {
          description: runAfterCreate
            ? `${failedUploads.join(", ")}. The run was not started; add the files again in the workspace, then run the case.`
            : `${failedUploads.join(", ")}. You can add them again in the workspace.`,
        });
      }

      // Uploads close once a run plans the case, so a run only starts with every file in place.
      if (runAfterCreate && !uploadsFailed) {
        setStatusMessage("Starting the run");
        try {
          await retryWhileUploadingAsync(() => dataSource.startRunAsync(caseId));
          trackEvent("case_submitted", { mode: "form", use_case: useCase });
        } catch (error) {
          toast.error("The run did not start", { description: describeError(error) });
        }
      }

      router.push(`/cases/${encodeURIComponent(caseId)}`);
    } catch (error) {
      toast.error("Could not create the case", { description: describeError(error) });
      setSubmitting(undefined);
      setStatusMessage("");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitAsync(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Guided setup</h1>
          <p className="text-sm text-muted-foreground">
            Pick the kind of work, describe it, and add what documents you have.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={submitting === "chat"}
          disabled={locked && submitting !== "chat"}
          onClick={() => void switchToChatAsync()}
        >
          {submitting === "chat" ? null : <MessageSquare aria-hidden />}
          Prefer to chat?
        </Button>
      </div>

      {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

      <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-8" noValidate>
        {/* Submission uses the details and files as they were when it started. */}
        <fieldset disabled={locked} className="contents">
          <section aria-labelledby={`${formId}-step-1`} className="flex flex-col gap-3">
            <StepHeading step={1} title="Choose the work" id={`${formId}-step-1`} />
            <UseCasePicker value={useCase} onChange={handleUseCaseChange} />
          </section>
        </fieldset>

        {definition ? (
          <>
            <fieldset disabled={locked} className="contents">
              <section aria-labelledby={`${formId}-step-2`} className="flex flex-col gap-4">
                <StepHeading step={2} title="Describe the case" id={`${formId}-step-2`} />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-title`}>Title</Label>
                  <Input
                    id={`${formId}-title`}
                    value={title}
                    maxLength={200}
                    aria-invalid={titleError ? true : undefined}
                    aria-describedby={titleError ? `${formId}-title-error` : undefined}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      setDetailsEdited(true);
                    }}
                  />
                  {titleError ? (
                    <p id={`${formId}-title-error`} className="text-sm text-danger">
                      {titleError}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${formId}-description`}>Short description</Label>
                  <Textarea
                    id={`${formId}-description`}
                    value={description}
                    rows={3}
                    maxLength={4000}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setDetailsEdited(true);
                    }}
                  />
                </div>
              </section>

              <section aria-labelledby={`${formId}-step-3`} className="flex flex-col gap-3">
                <StepHeading step={3} title="Add documents" id={`${formId}-step-3`} />
                <p className="text-sm text-muted-foreground">
                  Use synthetic or anonymised documents only. This demo is public. You can also get
                  items from a connected data source.
                </p>
                <UploadChecklist
                  checklist={definition.checklist}
                  files={files}
                  attachedDocuments={attachedDocuments}
                  disabled={locked}
                  onAddFiles={handleAddFiles}
                  onRemoveFile={handleRemoveFile}
                  onGetFromSource={(itemId) => void openDataSourceAsync(itemId)}
                />
              </section>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button
                type="submit"
                variant="outline"
                loading={submitting === "create"}
                disabled={Boolean(submitting)}
              >
                Create case
              </Button>
              <Button
                type="button"
                loading={submitting === "run"}
                disabled={Boolean(submitting)}
                onClick={() => void submitAsync(true)}
              >
                {submitting === "run" ? null : <Play aria-hidden />}
                Create and run
              </Button>
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                {statusMessage}
              </p>
            </div>
          </>
        ) : null}
      </form>

      {draftId ? (
        <BrowseSourceSheet
          open={browseItemId !== undefined}
          onOpenChange={(open) => !open && setBrowseItemId(undefined)}
          caseId={draftId}
          useCase={useCase}
          checklistItemId={browseItemId}
          onAttached={() => draft.reload()}
        />
      ) : null}
    </div>
  );
}
