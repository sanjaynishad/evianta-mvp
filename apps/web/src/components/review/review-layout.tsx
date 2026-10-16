"use client";

import {
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery, wideLayoutQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

export interface ReviewLayoutHandle {
  // Makes the evidence and Ask panel visible: expands it on wide screens, opens the sheet otherwise.
  revealSide: () => void;
  // Closes overlay sheets so a scroll target in the main content is visible; true when it closed any.
  showContent: () => boolean;
}

export interface ReviewLayoutProps {
  outline: ReactNode;
  content: ReactNode;
  side: ReactNode;
  sideLabel: string;
  handleRef?: Ref<ReviewLayoutHandle>;
  className?: string;
}

const paneSelector = "[data-review-pane]";

function focusNextPane(root: HTMLElement, backwards: boolean) {
  const panes = Array.from(root.querySelectorAll<HTMLElement>(paneSelector)).filter(
    (pane) => pane.dataset.collapsed !== "true",
  );
  if (panes.length === 0) {
    return;
  }

  const active = document.activeElement?.closest<HTMLElement>(paneSelector);
  const index = active ? panes.indexOf(active) : -1;
  const next = backwards
    ? panes[(index - 1 + panes.length) % panes.length]
    : panes[(index + 1) % panes.length];
  next?.focus();
}

export function ReviewLayout({
  outline,
  content,
  side,
  sideLabel,
  handleRef,
  className,
}: ReviewLayoutProps) {
  const wide = useMediaQuery(wideLayoutQuery);
  const rootRef = useRef<HTMLDivElement>(null);
  const outlinePanelRef = usePanelRef();
  const sidePanelRef = usePanelRef();
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [outlineSheetOpen, setOutlineSheetOpen] = useState(false);
  const [sideSheetOpen, setSideSheetOpen] = useState(false);
  const keepFocusRef = useRef(false);

  useImperativeHandle(
    handleRef,
    () => ({
      revealSide: () => {
        if (wide) {
          if (sidePanelRef.current?.isCollapsed()) {
            sidePanelRef.current.expand();
          }

          return;
        }

        setSideSheetOpen(true);
      },
      showContent: () => {
        if (!wide && (outlineSheetOpen || sideSheetOpen)) {
          keepFocusRef.current = true;
          setOutlineSheetOpen(false);
          setSideSheetOpen(false);
          return true;
        }

        return false;
      },
    }),
    [wide, sidePanelRef, outlineSheetOpen, sideSheetOpen],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "F6" && rootRef.current) {
      event.preventDefault();
      focusNextPane(rootRef.current, event.shiftKey);
    }
  }

  function togglePanel(panel: ReturnType<typeof usePanelRef>) {
    const handle = panel.current;
    if (!handle) {
      return;
    }

    if (handle.isCollapsed()) {
      handle.expand();
    } else {
      handle.collapse();
    }
  }

  function preventFocusReturn(event: Event) {
    if (keepFocusRef.current) {
      event.preventDefault();
      keepFocusRef.current = false;
    }
  }

  const paneClassName =
    "relative h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  if (!wide) {
    return (
      <div ref={rootRef} className={cn("flex flex-col gap-4", className)} onKeyDown={handleKeyDown}>
        <div
          role="toolbar"
          aria-label="Workspace panels"
          className="sticky top-14 z-20 -mx-4 flex gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 print:hidden"
        >
          <Button variant="outline" size="sm" onClick={() => setOutlineSheetOpen(true)}>
            <PanelLeft aria-hidden />
            Outline
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSideSheetOpen(true)}>
            <PanelRight aria-hidden />
            {sideLabel}
          </Button>
        </div>
        <Sheet open={outlineSheetOpen} onOpenChange={setOutlineSheetOpen}>
          <SheetContent
            side="left"
            className="w-80 overflow-y-auto p-5"
            onCloseAutoFocus={preventFocusReturn}
          >
            <SheetTitle className="sr-only">Case outline</SheetTitle>
            <SheetDescription className="sr-only">
              Sections, steps, cost, and open questions
            </SheetDescription>
            {outline}
          </SheetContent>
        </Sheet>
        <Sheet open={sideSheetOpen} onOpenChange={setSideSheetOpen}>
          <SheetContent
            side="right"
            className="flex w-full flex-col p-0 sm:max-w-xl"
            onCloseAutoFocus={preventFocusReturn}
          >
            <SheetTitle className="sr-only">{sideLabel}</SheetTitle>
            <SheetDescription className="sr-only">
              Source documents with highlights, and grounded questions about this case
            </SheetDescription>
            <div className="min-h-0 flex-1">{side}</div>
          </SheetContent>
        </Sheet>
        <div data-review-pane="content" tabIndex={-1} className="focus:outline-none">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background print:overflow-visible print:border-0",
        className,
      )}
      onKeyDown={handleKeyDown}
    >
      <div
        role="toolbar"
        aria-label="Workspace panels"
        aria-keyshortcuts="F6"
        className="flex items-center gap-2 border-b px-2 py-1 print:hidden"
      >
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!outlineCollapsed}
          onClick={() => togglePanel(outlinePanelRef)}
        >
          <PanelLeft aria-hidden />
          Outline
        </Button>
        <span className="flex-1 text-center text-xs text-muted-foreground">
          Press F6 to move between panels
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!sideCollapsed}
          onClick={() => togglePanel(sidePanelRef)}
        >
          <PanelRight aria-hidden />
          {sideLabel}
        </Button>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          id="review-outline"
          panelRef={outlinePanelRef}
          defaultSize="21"
          minSize="14"
          maxSize="34"
          collapsible
          collapsedSize="0"
          onResize={(size) => setOutlineCollapsed(size.asPercentage <= 0)}
        >
          <div
            data-review-pane="outline"
            data-collapsed={outlineCollapsed || undefined}
            role="region"
            aria-label="Outline"
            tabIndex={-1}
            className={cn(paneClassName, "overflow-y-auto bg-sidebar/40 p-4")}
          >
            {outline}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize the outline" />
        <ResizablePanel id="review-content" defaultSize="47" minSize="30">
          <div
            data-review-pane="content"
            role="region"
            aria-label="Deliverable"
            tabIndex={-1}
            className={cn(paneClassName, "overflow-y-auto p-4 xl:p-6")}
          >
            {content}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={`Resize ${sideLabel.toLowerCase()}`} />
        <ResizablePanel
          id="review-side"
          panelRef={sidePanelRef}
          defaultSize="32"
          minSize="22"
          maxSize="55"
          collapsible
          collapsedSize="0"
          onResize={(size) => setSideCollapsed(size.asPercentage <= 0)}
        >
          <div
            data-review-pane="side"
            data-collapsed={sideCollapsed || undefined}
            role="region"
            aria-label={sideLabel}
            tabIndex={-1}
            className={cn(paneClassName, "overflow-hidden")}
          >
            {side}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
