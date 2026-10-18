"use client";

import { useState } from "react";
import { Paperclip, Plug } from "lucide-react";
import {
  findChecklistItem,
  findSourceConnector,
  lowerFirstWord,
  type SourceAttachResponse,
  type SourceConnection,
  type SourceItem,
  type UseCase,
} from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useResource } from "@/hooks/use-resource";
import { useSourceConnections } from "@/hooks/use-source-connections";
import { trackEvent } from "@/lib/analytics";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { ConnectSourceDialog } from "./connect-source-dialog";
import { SourceMonogram } from "./source-monogram";

export interface BrowseSourceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: string;
  useCase?: UseCase;
  // Narrows the list to items that can fill this checklist item.
  checklistItemId?: string;
  onAttached: (response: SourceAttachResponse) => void;
}

function ConnectionItems({
  connection,
  checklistItemId,
  attachingId,
  onAttach,
}: {
  connection: SourceConnection;
  checklistItemId?: string;
  attachingId?: string;
  onAttach: (connection: SourceConnection, item: SourceItem) => void;
}) {
  const dataSource = useDataSource();
  const items = useResource(`source-items:${connection.id}`, () =>
    dataSource.listSourceItemsAsync(connection.id),
  );
  const connector = findSourceConnector(connection.connectorId);
  const visible = (items.data ?? []).filter(
    (item) => !checklistItemId || item.satisfies.includes(checklistItemId),
  );
  if (items.data && visible.length === 0) {
    return null;
  }

  return (
    <section aria-label={connector?.name ?? connection.connectorId} className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <SourceMonogram connectorId={connection.connectorId} size="sm" />
        {connector?.name ?? connection.connectorId}
        <span className="text-xs font-normal text-muted-foreground">Demo</span>
      </h3>
      {items.error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-danger/40 p-2.5"
        >
          <span className="text-sm text-danger">{describeError(items.error)}</span>
          <Button size="sm" variant="outline" onClick={items.reload}>
            Try again
          </Button>
        </div>
      ) : !items.data ? (
        <Skeleton className="h-14 rounded-md" />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((item) => {
            const key = `${connection.id}:${item.id}`;
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border bg-card p-2.5"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{item.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[item.detail, item.fileName].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  loading={attachingId === key}
                  disabled={Boolean(attachingId)}
                  onClick={() => onAttach(connection, item)}
                  aria-label={`Attach ${item.label}`}
                >
                  {attachingId === key ? null : <Paperclip aria-hidden />}
                  Attach
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function BrowseSourceSheet({
  open,
  onOpenChange,
  caseId,
  useCase,
  checklistItemId,
  onAttached,
}: BrowseSourceSheetProps) {
  const dataSource = useDataSource();
  const sources = useSourceConnections();
  const [attachingId, setAttachingId] = useState<string>();
  const [connectOpen, setConnectOpen] = useState(false);
  const checklistItem = checklistItemId ? findChecklistItem(useCase, checklistItemId) : undefined;

  async function attachAsync(connection: SourceConnection, item: SourceItem) {
    setAttachingId(`${connection.id}:${item.id}`);
    try {
      const response = await dataSource.importSourceItemAsync(caseId, {
        connectionId: connection.id,
        itemId: item.id,
        ...(checklistItemId ? { checklistItemId } : {}),
      });
      trackEvent("source_items_attached", { connector: connection.connectorId, count: 1 });
      onAttached(response);
      onOpenChange(false);
    } catch (error) {
      toast.error("Could not attach the item", { description: describeError(error) });
    } finally {
      setAttachingId(undefined);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>
              {checklistItem
                ? `Get ${lowerFirstWord(checklistItem.label)}`
                : "Get from a data source"}
            </SheetTitle>
            <SheetDescription>
              Pick an item to attach to this case. Items come from demo connections with synthetic
              data.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-5 px-5 pb-5">
            {sources.connections.length === 0 ? (
              <EmptyState
                icon={Plug}
                title="No data sources yet"
                description="Connect an app to pull records straight into the case."
                action={
                  <Button variant="outline" onClick={() => setConnectOpen(true)}>
                    Connect a source
                  </Button>
                }
              />
            ) : (
              sources.connections.map((connection) => (
                <ConnectionItems
                  key={connection.id}
                  connection={connection}
                  checklistItemId={checklistItemId}
                  attachingId={attachingId}
                  onAttach={(target, item) => void attachAsync(target, item)}
                />
              ))
            )}
            {sources.connections.length > 0 ? (
              <Button variant="ghost" className="self-start" onClick={() => setConnectOpen(true)}>
                <Plug aria-hidden />
                Connect another source
              </Button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <ConnectSourceDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
