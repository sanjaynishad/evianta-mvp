"use client";

import { BarChart3, FileText, Landmark, type LucideIcon } from "lucide-react";
import { useCaseDefinitions, useCaseOrder, type UseCase } from "@evianta/core";
import { cn } from "@/lib/utils";

export const useCaseIcons: Record<UseCase, LucideIcon> = {
  "data-analysis": BarChart3,
  "tax-notice": FileText,
  "msme-payment": Landmark,
};

export interface UseCaseChoiceCardProps {
  suggested?: UseCase;
  supported: boolean;
  disabled?: boolean;
  onChoose: (useCase: UseCase) => void;
}

export function UseCaseChoiceCard({
  suggested,
  supported,
  disabled,
  onChoose,
}: UseCaseChoiceCardProps) {
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">
        {supported ? "Pick the kind of work" : "I can help with these instead"}
      </p>
      <ul className="grid gap-2 sm:grid-cols-3">
        {useCaseOrder.map((useCase) => {
          const definition = useCaseDefinitions[useCase];
          const Icon = useCaseIcons[useCase];
          return (
            <li key={useCase}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChoose(useCase)}
                className={cn(
                  "flex h-full w-full flex-col gap-1.5 rounded-lg border bg-background p-3 text-left transition-colors duration-fast ease-standard hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
                  suggested === useCase && "border-primary/50 bg-primary-subtle",
                )}
              >
                <Icon aria-hidden className="size-4 text-primary" />
                <span className="text-sm font-medium">{definition.title}</span>
                <span className="line-clamp-3 text-xs text-muted-foreground">
                  {definition.outcome}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
