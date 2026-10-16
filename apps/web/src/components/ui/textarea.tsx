import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { fieldBaseClassName } from "@/components/ui/input";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldBaseClassName, "min-h-20 py-2 leading-relaxed", className)}
      {...props}
    />
  );
}
