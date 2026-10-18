import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export interface EviantaLogomarkProps extends Omit<ComponentProps<"svg">, "children"> {
  title?: string;
  tone?: "brand" | "muted";
}

export function EviantaLogomark({
  title,
  tone = "brand",
  className,
  ...props
}: EviantaLogomarkProps) {
  const labelled = Boolean(title);
  return (
    <svg
      viewBox="0 0 32 32"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn("size-8 shrink-0", className)}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <rect
        width="32"
        height="32"
        rx="8"
        className={tone === "brand" ? "fill-primary" : "fill-muted-foreground/15"}
      />
      <path
        d="M7 7h18M7 16h13M7 25h18"
        fill="none"
        strokeWidth="3.5"
        strokeLinecap="round"
        className={tone === "brand" ? "stroke-primary-foreground" : "stroke-muted-foreground"}
      />
    </svg>
  );
}

export interface EviantaWordmarkProps extends ComponentProps<"span"> {
  showMark?: boolean;
}

export function EviantaWordmark({ showMark = true, className, ...props }: EviantaWordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)} {...props}>
      {showMark ? <EviantaLogomark className="size-7" /> : null}
      <span className="text-base font-semibold tracking-tight text-foreground">Evianta</span>
    </span>
  );
}
