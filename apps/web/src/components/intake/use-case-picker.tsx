"use client";

import { BarChart3, FileWarning, Handshake, type LucideIcon } from "lucide-react";
import type { UseCase } from "@evianta/core";
import { useCaseDefinitions, useCaseOrder } from "@/lib/use-cases";
import { cn } from "@/lib/utils";

const useCaseIcons: Record<UseCase, LucideIcon> = {
  "data-analysis": BarChart3,
  "tax-notice": FileWarning,
  "msme-payment": Handshake,
};

export interface UseCasePickerProps {
  value: UseCase | undefined;
  onChange: (useCase: UseCase) => void;
  name?: string;
}

export function UseCasePicker({ value, onChange, name = "use-case" }: UseCasePickerProps) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 text-sm font-medium">What do you need done?</legend>
      <div className="grid gap-3 md:grid-cols-3">
        {useCaseOrder.map((useCase) => {
          const definition = useCaseDefinitions[useCase];
          const Icon = useCaseIcons[useCase];
          const checked = value === useCase;
          const inputId = `${name}-${useCase}`;
          return (
            <label
              key={useCase}
              htmlFor={inputId}
              data-checked={checked || undefined}
              className={cn(
                "group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-4 shadow-elevation-1 transition-[border-color,box-shadow] duration-fast ease-standard hover:shadow-elevation-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked && "border-primary ring-1 ring-primary",
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={useCase}
                checked={checked}
                onChange={() => onChange(useCase)}
                className="sr-only"
                aria-describedby={`${inputId}-outcome`}
              />
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground",
                  checked && "bg-primary-subtle text-primary",
                )}
              >
                <Icon aria-hidden className="size-5" />
              </span>
              <span className="text-sm font-semibold text-foreground">{definition.title}</span>
              <span id={`${inputId}-outcome`} className="text-sm text-muted-foreground">
                {definition.outcome}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
