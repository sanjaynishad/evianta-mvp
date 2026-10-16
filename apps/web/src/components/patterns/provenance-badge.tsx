import { Calculator, FileText, PenLine, UserCheck, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProvenanceKind = "source" | "computed" | "specialist" | "review" | "user";

interface ProvenanceMeta {
  label: string;
  icon: LucideIcon;
}

export const provenanceMeta: Record<ProvenanceKind, ProvenanceMeta> = {
  source: { label: "From source", icon: FileText },
  computed: { label: "Computed", icon: Calculator },
  specialist: { label: "Specialist", icon: Users },
  review: { label: "Independent review", icon: UserCheck },
  user: { label: "Your input", icon: PenLine },
};

export interface ProvenanceBadgeProps {
  kind: ProvenanceKind;
  by?: string;
  className?: string;
}

export function ProvenanceBadge({ kind, by, className }: ProvenanceBadgeProps) {
  const meta = provenanceMeta[kind];
  const Icon = meta.icon;
  return (
    <span
      data-provenance={kind}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="text-foreground">{meta.label}</span>
      {by ? <span>&middot; {by}</span> : null}
    </span>
  );
}
