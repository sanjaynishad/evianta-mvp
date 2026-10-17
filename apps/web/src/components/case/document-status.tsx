import {
  CircleCheck,
  CircleX,
  Clock,
  FileExclamationPoint,
  LoaderCircle,
  PenLine,
  ScanText,
  type LucideIcon,
} from "lucide-react";
import type { DocumentStatus } from "@evianta/core";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { documentStatusLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type DocumentDisplayStatus = DocumentStatus | "uploading";

const statusMeta: Record<
  DocumentDisplayStatus,
  { icon: LucideIcon; variant: NonNullable<BadgeProps["variant"]>; spinning?: boolean }
> = {
  uploading: { icon: LoaderCircle, variant: "primary", spinning: true },
  pending: { icon: Clock, variant: "neutral" },
  processing: { icon: ScanText, variant: "info" },
  ready: { icon: CircleCheck, variant: "success" },
  partial: { icon: FileExclamationPoint, variant: "warning" },
  failed: { icon: CircleX, variant: "danger" },
};

export interface DocumentStatusBadgeProps {
  status: DocumentDisplayStatus;
  className?: string;
}

export function DocumentStatusBadge({ status, className }: DocumentStatusBadgeProps) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} data-document-status={status} className={className}>
      <Icon
        aria-hidden
        className={cn(
          meta.spinning && "animate-spin [animation-duration:1.6s] motion-reduce:animate-none",
        )}
      />
      {status === "uploading" ? "Uploading" : documentStatusLabels[status]}
    </Badge>
  );
}

export function HandwritingBadge() {
  return (
    <Badge variant="warning" data-handwriting>
      <PenLine aria-hidden />
      Handwriting detected, flagged for review
    </Badge>
  );
}
