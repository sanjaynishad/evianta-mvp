"use client";

import { useId, useState } from "react";
import { Play } from "lucide-react";
import {
  buildIntakeRequirements,
  createCaseIntake,
  summarizeIntakeRequirements,
  useCaseDefinitions,
  type CaseState,
  type UpdateCaseRequest,
} from "@evianta/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface SubmitConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: CaseState;
  submitting: boolean;
  onConfirm: (details: UpdateCaseRequest) => void;
}

export function SubmitConfirmDialog({
  open,
  onOpenChange,
  state,
  submitting,
  onConfirm,
}: SubmitConfirmDialogProps) {
  const formId = useId();
  const [title, setTitle] = useState(state.case.title);
  const [description, setDescription] = useState(state.case.description ?? "");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle(state.case.title);
      setDescription(state.case.description ?? "");
    }
  }

  const useCase = state.case.useCase;
  if (!useCase) {
    return null;
  }

  const requirements = buildIntakeRequirements(
    useCase,
    state.documents,
    state.case.intake ?? createCaseIntake("chat"),
  );
  const progress = summarizeIntakeRequirements(requirements);
  const skipped = requirements.filter((entry) => entry.status === "skipped");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start the work?</DialogTitle>
          <DialogDescription>
            {useCaseDefinitions[useCase].title}. Once the specialists start, the documents for this
            case are fixed.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedTitle = title.trim();
            onConfirm({
              ...(trimmedTitle && trimmedTitle !== state.case.title ? { title: trimmedTitle } : {}),
              ...(description.trim() !== (state.case.description ?? "")
                ? { description: description.trim() }
                : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-title`}>Title</Label>
            <Input
              id={`${formId}-title`}
              value={title}
              maxLength={200}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-description`}>What should the specialists focus on?</Label>
            <Textarea
              id={`${formId}-description`}
              value={description}
              rows={3}
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 rounded-lg bg-muted/60 p-3 text-sm">
            <p>
              <span className="figures font-medium">{state.documents.length}</span>{" "}
              {state.documents.length === 1 ? "document" : "documents"} attached,{" "}
              <span className="figures font-medium">
                {progress.recommendedReceived} of {progress.recommendedTotal}
              </span>{" "}
              recommended items received.
            </p>
            {progress.missingRecommended.length > 0 || skipped.length > 0 ? (
              <p className="text-muted-foreground">
                Not provided:{" "}
                {[...progress.missingRecommended, ...skipped.map((entry) => entry.item)]
                  .map((item) => item.label)
                  .join(", ")}
                . These become open questions for your review.
              </p>
            ) : null}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Keep gathering
          </Button>
          <Button type="submit" form={formId} loading={submitting} disabled={!title.trim()}>
            {submitting ? null : <Play aria-hidden />}
            Start work
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
