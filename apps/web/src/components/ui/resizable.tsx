"use client";

import type { ComponentProps } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export { usePanelRef };

export function ResizablePanelGroup({
  className,
  orientation = "horizontal",
  ...props
}: ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={orientation}
      className={cn("flex size-full", orientation === "vertical" && "flex-col", className)}
      {...props}
    />
  );
}

export function ResizablePanel(props: ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

export interface ResizableHandleProps extends ComponentProps<typeof Separator> {
  withHandle?: boolean;
}

export function ResizableHandle({ withHandle = false, className, ...props }: ResizableHandleProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border transition-colors duration-fast after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 hover:bg-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 data-[separator=active]:bg-primary",
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical aria-hidden className="size-2.5" />
        </div>
      ) : null}
    </Separator>
  );
}
