"use client";

import { useState } from "react";
import { Plug, Unplug } from "lucide-react";
import { findSourceConnector } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSourceConnections } from "@/hooks/use-source-connections";
import { formatDateTime } from "@/lib/format";
import { ConnectSourceDialog } from "./connect-source-dialog";
import { SourceMonogram } from "./source-monogram";

export interface ManageSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManageSourcesDialog({ open, onOpenChange }: ManageSourcesDialogProps) {
  const sources = useSourceConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string>();

  async function disconnectAsync(connectionId: string) {
    setDisconnectingId(connectionId);
    try {
      await sources.disconnectAsync(connectionId);
    } finally {
      setDisconnectingId(undefined);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Data sources</DialogTitle>
            <DialogDescription>
              Apps linked in this browser. Disconnecting keeps documents already attached to your
              cases.
            </DialogDescription>
          </DialogHeader>
          {sources.connections.length === 0 ? (
            <EmptyState
              icon={Plug}
              title="No data sources yet"
              description="Connect Tally, Gmail, Shopify, and more to fill a case faster."
            />
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {sources.connections.map((connection) => {
                const connector = findSourceConnector(connection.connectorId);
                return (
                  <li key={connection.id} className="flex items-center gap-3 p-3">
                    <SourceMonogram connectorId={connection.connectorId} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {connector?.name ?? connection.connectorId}
                        <Badge variant="neutral">Demo</Badge>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {connection.lastImportAt
                          ? `Last used ${formatDateTime(connection.lastImportAt)}`
                          : `Connected ${formatDateTime(connection.connectedAt)}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={disconnectingId === connection.id}
                      onClick={() => void disconnectAsync(connection.id)}
                      aria-label={`Disconnect ${connector?.name ?? connection.connectorId}`}
                    >
                      {disconnectingId === connection.id ? null : <Unplug aria-hidden />}
                      Disconnect
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <Button variant="outline" className="self-start" onClick={() => setConnectOpen(true)}>
            <Plug aria-hidden />
            Connect a source
          </Button>
        </DialogContent>
      </Dialog>
      <ConnectSourceDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
