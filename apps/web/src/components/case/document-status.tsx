import {
  CircleCheck,
  CircleX,
  Clock,
  FileSearch,
  LoaderCircle,
  PenLine,
  ScanText,
  type LucideIcon,
} from "lucide-react";
import type { DocumentProcessingStatus } from "@evianta/core";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { documentProcessingLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type DocumentDisplayStatus = DocumentProcessingStatus | "uploading";

const statusMeta: Record<
  DocumentDisplayStatus,
  { icon: LucideIcon; variant: NonNullable<BadgeProps["variant"]>; spinning?: boolean }
> = {
  uploading: { icon: LoaderCircle, variant: "primary", spinning: true },
  queued: { icon: Clock, variant: "neutral" },
  "reading-text": { icon: FileSearch, variant: "info", spinning: false },
  ocr: { icon: ScanText, variant: "info" },
  ready: { icon: CircleCheck, variant: "success" },
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
      {status === "uploading" ? "Uploading" : documentProcessingLabels[status]}
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
