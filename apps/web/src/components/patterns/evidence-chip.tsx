import type { ComponentProps } from "react";
import { FileImage, FileSpreadsheet, FileText, Globe, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type EvidenceSourceKind = "document" | "spreadsheet" | "image" | "web";

const sourceIcons: Record<EvidenceSourceKind, LucideIcon> = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  image: FileImage,
  web: Globe,
};

export interface EvidenceChipProps extends Omit<ComponentProps<"button">, "children"> {
  label: string;
  locator?: string;
  kind?: EvidenceSourceKind;
  selected?: boolean;
  pulse?: boolean;
}

export function EvidenceChip({
  label,
  locator,
  kind = "document",
  selected = false,
  pulse = false,
  className,
  type = "button",
  ...props
}: EvidenceChipProps) {
  const Icon = sourceIcons[kind];
  return (
    <button
      type={type}
      data-slot="evidence-chip"
      data-selected={selected || undefined}
      aria-pressed={selected}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-standard hover:border-highlight/60 hover:bg-highlight-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.98] motion-reduce:active:scale-100",
        selected && "border-highlight bg-highlight-subtle text-highlight",
        pulse && "animate-evidence-pulse motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {locator ? (
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{locator}</span>
      ) : null}
    </button>
  );
}
