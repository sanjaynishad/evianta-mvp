import { findSourceConnector, type SourceConnectorId } from "@evianta/core";
import { cn } from "@/lib/utils";

const monogramTones: Record<SourceConnectorId, string> = {
  tally: "bg-primary-subtle text-primary",
  busy: "bg-info-subtle text-info",
  "zoho-books": "bg-warning-subtle text-warning",
  shopify: "bg-success-subtle text-success",
  gmail: "bg-danger-subtle text-danger",
  outlook: "bg-info-subtle text-info",
  "google-drive": "bg-highlight-subtle text-highlight",
};

export interface SourceMonogramProps {
  connectorId: SourceConnectorId;
  size?: "sm" | "md";
  className?: string;
}

// A neutral lettermark rather than a third-party logo.
export function SourceMonogram({ connectorId, size = "md", className }: SourceMonogramProps) {
  const connector = findSourceConnector(connectorId);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold",
        size === "md" ? "size-9 text-sm" : "size-5 text-[10px]",
        monogramTones[connectorId],
        className,
      )}
    >
      {connector?.monogram ?? "?"}
    </span>
  );
}
