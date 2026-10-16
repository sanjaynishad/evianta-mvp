import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  FilePen,
  Hourglass,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type WorkStatus =
  | "draft"
  | "needs-input"
  | "planning"
  | "awaiting-approval"
  | "pending"
  | "queued"
  | "in-progress"
  | "running"
  | "blocked"
  | "verifying"
  | "review"
  | "completed"
  | "failed";

interface StatusMeta {
  label: string;
  variant: NonNullable<BadgeProps["variant"]>;
  icon: LucideIcon;
  spinning?: boolean;
}

export const statusMeta: Record<WorkStatus, StatusMeta> = {
  draft: { label: "Draft", variant: "neutral", icon: FilePen },
  "needs-input": { label: "Needs input", variant: "warning", icon: MessageCircleQuestion },
  planning: { label: "Planning", variant: "info", icon: ListChecks },
  "awaiting-approval": { label: "Awaiting approval", variant: "warning", icon: Hourglass },
  pending: { label: "Queued", variant: "neutral", icon: Clock },
  queued: { label: "Queued", variant: "neutral", icon: Clock },
  "in-progress": { label: "In progress", variant: "primary", icon: LoaderCircle, spinning: true },
  running: { label: "Running", variant: "primary", icon: LoaderCircle, spinning: true },
  blocked: { label: "Blocked", variant: "danger", icon: Ban },
  verifying: { label: "Verifying", variant: "info", icon: ShieldCheck },
  review: { label: "In review", variant: "info", icon: Eye },
  completed: { label: "Completed", variant: "success", icon: CircleCheck },
  failed: { label: "Failed", variant: "danger", icon: CircleX },
};

export interface StatusBadgeProps {
  status: WorkStatus;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} data-status={status} className={className}>
      <Icon
        aria-hidden
        className={cn(
          meta.spinning && "animate-spin [animation-duration:1.6s] motion-reduce:animate-none",
        )}
      />
      {label ?? meta.label}
    </Badge>
  );
}
