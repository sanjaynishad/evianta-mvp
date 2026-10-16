import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-fast ease-standard [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-background text-foreground",
        neutral: "border-border bg-muted text-muted-foreground",
        primary: "border-primary/20 bg-primary-subtle text-primary",
        highlight: "border-highlight/25 bg-highlight-subtle text-highlight",
        success: "border-success/20 bg-success-subtle text-success",
        warning: "border-warning/25 bg-warning-subtle text-warning",
        danger: "border-danger/20 bg-danger-subtle text-danger",
        info: "border-info/20 bg-info-subtle text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
