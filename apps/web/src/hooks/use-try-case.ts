"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/sonner";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";

// "Try this case": copy a read-only sample into the visitor's cases and open the copy.
export function useTryCase(options: { openIn?: "workspace" | "chat" } = {}) {
  const openIn = options.openIn ?? "workspace";
  const dataSource = useDataSource();
  const router = useRouter();
  const [copyingCaseId, setCopyingCaseId] = useState<string>();

  const tryCaseAsync = useCallback(
    async (caseId: string) => {
      setCopyingCaseId(caseId);
      try {
        const copy = await dataSource.copyCaseAsync(caseId);
        toast.success("Copied to your cases", {
          description:
            "You can run this copy and edit its results. Start a new case to use your own documents.",
        });
        router.push(
          openIn === "chat"
            ? `/chat/${encodeURIComponent(copy.id)}`
            : `/cases/${encodeURIComponent(copy.id)}`,
        );
      } catch (error) {
        toast.error("Could not copy this case", { description: describeError(error) });
      } finally {
        setCopyingCaseId(undefined);
      }
    },
    [dataSource, router, openIn],
  );

  return { tryCaseAsync, copyingCaseId };
}
