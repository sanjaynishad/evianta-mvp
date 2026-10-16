import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const fieldBaseClassName =
  "w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-elevation-1 transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/30";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        fieldBaseClassName,
        "h-9 py-1 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}
