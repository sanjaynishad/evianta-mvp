"use client";

import type { ReactNode } from "react";
import { FileSearch, MessagesSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReview, type ReviewPanel } from "./review-context";

export interface ReviewSidePanelProps {
  evidence: ReactNode;
  ask: ReactNode;
}

export function ReviewSidePanel({ evidence, ask }: ReviewSidePanelProps) {
  const review = useReview();
  return (
    <Tabs
      value={review.panel}
      onValueChange={(value) => review.setPanel(value as ReviewPanel)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="border-b px-3 py-2">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="evidence">
            <FileSearch aria-hidden />
            Evidence
          </TabsTrigger>
          <TabsTrigger value="ask">
            <MessagesSquare aria-hidden />
            Ask
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="evidence"
        forceMount
        className="mt-0 min-h-0 flex-1 overflow-y-auto p-3 data-[state=inactive]:hidden"
      >
        {evidence}
      </TabsContent>
      <TabsContent
        value="ask"
        forceMount
        className="mt-0 flex min-h-0 flex-1 flex-col p-3 data-[state=inactive]:hidden"
      >
        {ask}
      </TabsContent>
    </Tabs>
  );
}
