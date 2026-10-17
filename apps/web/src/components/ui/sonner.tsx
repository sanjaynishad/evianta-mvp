"use client";

import type { ComponentProps, CSSProperties } from "react";
import { useTheme } from "next-themes";
import { Toaster as SonnerToaster } from "sonner";
import { motionDurationMs } from "@/lib/motion";

export type ToasterProps = ComponentProps<typeof SonnerToaster>;

// Sonner's styled mode reads these variables from per-theme selectors. Inline values win over
// those selectors, and the token variables resolve per theme through the root class.
export const toasterTokenStyle = {
  "--normal-bg": "hsl(var(--popover))",
  "--normal-text": "hsl(var(--popover-foreground))",
  "--normal-border": "hsl(var(--border))",
  "--normal-bg-hover": "hsl(var(--accent))",
  "--normal-border-hover": "hsl(var(--border))",
  "--border-radius": "var(--radius)",
  "--gray1": "hsl(var(--popover))",
  "--gray2": "hsl(var(--accent))",
  "--gray4": "hsl(var(--border))",
  "--gray5": "hsl(var(--border))",
  "--gray11": "hsl(var(--muted-foreground))",
  "--gray12": "hsl(var(--popover-foreground))",
  "--success-bg": "hsl(var(--success-subtle))",
  "--success-text": "hsl(var(--success))",
  "--success-border": "hsl(var(--success) / 0.25)",
  "--info-bg": "hsl(var(--info-subtle))",
  "--info-text": "hsl(var(--info))",
  "--info-border": "hsl(var(--info) / 0.25)",
  "--warning-bg": "hsl(var(--warning-subtle))",
  "--warning-text": "hsl(var(--warning))",
  "--warning-border": "hsl(var(--warning) / 0.25)",
  "--error-bg": "hsl(var(--danger-subtle))",
  "--error-text": "hsl(var(--danger))",
  "--error-border": "hsl(var(--danger) / 0.25)",
} as CSSProperties;

export function Toaster({ style, toastOptions, ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="bottom-right"
      duration={motionDurationMs.slow * 15}
      visibleToasts={4}
      className="toaster group"
      style={{ ...toasterTokenStyle, ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: "group toast font-sans",
          title: "text-sm font-medium",
          description: "text-sm",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-danger",
          warning: "[&_[data-icon]]:text-warning",
          info: "[&_[data-icon]]:text-info",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
