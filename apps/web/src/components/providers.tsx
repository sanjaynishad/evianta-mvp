"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      themes={["light", "dark"]}
      enableSystem={false}
      disableTransitionOnChange
    >
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
