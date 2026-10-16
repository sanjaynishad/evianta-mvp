import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

export interface AppShellProps {
  children: ReactNode;
  caseContext?: ReactNode;
  className?: string;
}

export function AppShell({ children, caseContext, className }: AppShellProps) {
  return (
    <div className="flex min-h-dvh bg-background">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 border-r border-sidebar-border bg-sidebar md:block lg:w-56 print:hidden">
        <SidebarNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar caseContext={caseContext} />
        <main
          id="main-content"
          tabIndex={-1}
          className={cn("flex-1 focus:outline-none", className)}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export interface CaseContextLabelProps {
  eyebrow?: string;
  title: string;
  meta?: ReactNode;
}

export function CaseContextLabel({ eyebrow, title, meta }: CaseContextLabelProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="truncate text-xs font-medium text-muted-foreground">{eyebrow}</p>
        ) : null}
        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
      </div>
      {meta}
    </div>
  );
}

export interface PageContainerProps {
  children: ReactNode;
  width?: "reading" | "wide" | "full";
  className?: string;
}

export function PageContainer({ children, width = "wide", className }: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 lg:py-8",
        width === "reading" && "max-w-3xl",
        width === "wide" && "max-w-6xl",
        width === "full" && "max-w-none px-0 py-0 sm:px-0 lg:py-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
