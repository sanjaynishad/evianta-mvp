"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import type { UseCase } from "@evianta/core";
import { FixtureModeNotice } from "@/components/case/fixture-mode-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { matchChecklistItem, useCaseDefinitions } from "@/lib/use-cases";
import { UploadChecklist, type IntakeFile } from "./upload-checklist";
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
  const formId = useId();
  const [useCase, setUseCase] = useState<UseCase>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [detailsEdited, setDetailsEdited] = useState(false);
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [submitting, setSubmitting] = useState<"create" | "run">();
  const [statusMessage, setStatusMessage] = useState("");
  const [titleError, setTitleError] = useState<string>();
  const definition = useCase ? useCaseDefinitions[useCase] : undefined;

  function handleUseCaseChange(next: UseCase) {
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

  function handleAddFiles(added: File[], itemId?: string) {
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

  async function submitAsync(runAfterCreate: boolean) {
    if (!useCase) {
      return;
    }

    if (!title.trim()) {
      setTitleError("Give the case a title.");
      return;
    }

    setTitleError(undefined);
    setSubmitting(runAfterCreate ? "run" : "create");
    try {
      setStatusMessage("Creating the case");
      const created = await dataSource.createCaseAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        useCase,
      });
      const failedUploads: string[] = [];
      for (const [index, entry] of files.entries()) {
        setStatusMessage(`Uploading ${index + 1} of ${files.length}: ${entry.file.name}`);
        try {
          await dataSource.uploadDocumentAsync(created.id, entry.file);
        } catch {
          failedUploads.push(entry.file.name);
        }
      }

      if (failedUploads.length > 0) {
        toast.error("Some files did not upload", {
          description: `${failedUploads.join(", ")}. You can add them again in the workspace.`,
        });
      }

      if (runAfterCreate) {
        setStatusMessage("Starting the run");
        try {
          await dataSource.startRunAsync(created.id);
        } catch (error) {
          toast.error("The run did not start", { description: describeError(error) });
        }
      }

      router.push(`/cases/${encodeURIComponent(created.id)}`);
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
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">New case</h1>
        <p className="text-sm text-muted-foreground">
          Pick the kind of work, describe it, and add what documents you have.
        </p>
      </div>

      {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

      <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-8" noValidate>
        <section aria-labelledby={`${formId}-step-1`} className="flex flex-col gap-3">
          <StepHeading step={1} title="Choose the work" id={`${formId}-step-1`} />
          <UseCasePicker value={useCase} onChange={handleUseCaseChange} />
        </section>

        {definition ? (
          <>
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
                Use synthetic or anonymised documents only. This demo is public.
              </p>
              <UploadChecklist
                checklist={definition.checklist}
                files={files}
                onAddFiles={handleAddFiles}
                onRemoveFile={(id) =>
                  setFiles((current) => current.filter((entry) => entry.id !== id))
                }
              />
            </section>

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
    </div>
  );
}
