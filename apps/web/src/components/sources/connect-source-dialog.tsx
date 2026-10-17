"use client";

import { useState } from "react";
import { ArrowLeft, Check, Lock } from "lucide-react";
import {
  sourceCategoryLabels,
  sourceConnectorCatalog,
  type SourceCategory,
  type SourceConnection,
  type SourceConnectorDefinition,
  type SourceConnectorId,
} from "@evianta/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSourceConnections } from "@/hooks/use-source-connections";
import { cn } from "@/lib/utils";
import { SourceMonogram } from "./source-monogram";

const categoryOrder: SourceCategory[] = ["accounting", "commerce", "email", "files"];

export interface ConnectSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Opens straight on the consent step for this connector.
  initialConnectorId?: SourceConnectorId;
  onConnected?: (connection: SourceConnection) => void;
}

function SourceTile({
  connector,
  connected,
  onSelect,
}: {
  connector: SourceConnectorDefinition;
  connected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors duration-fast ease-standard hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        connected && "border-success/30",
      )}
    >
      <SourceMonogram connectorId={connector.id} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {connector.name}
          {connected ? (
            <Badge variant="success" className="gap-1">
              <Check aria-hidden className="size-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="neutral">Demo</Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{connector.provides}</span>
      </span>
    </button>
  );
}

export function ConnectSourceDialog({
  open,
  onOpenChange,
  initialConnectorId,
  onConnected,
}: ConnectSourceDialogProps) {
  const sources = useSourceConnections();
  const [selectedId, setSelectedId] = useState<SourceConnectorId | undefined>(initialConnectorId);
  const [lastInitial, setLastInitial] = useState(initialConnectorId);
  if (initialConnectorId !== lastInitial) {
    setLastInitial(initialConnectorId);
    setSelectedId(initialConnectorId);
  }

  const selected = sourceConnectorCatalog.find((connector) => connector.id === selectedId);
  const existing = selected ? sources.connectionFor(selected.id) : undefined;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelectedId(initialConnectorId);
    }

    onOpenChange(next);
  }

  async function connectAsync() {
    if (!selected) {
      return;
    }

    const connection = existing ?? (await sources.connectAsync(selected.id));
    if (connection) {
      onConnected?.(connection);
      handleOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {selected ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <SourceMonogram connectorId={selected.id} />
                Connect {selected.name}
              </DialogTitle>
              <DialogDescription>
                This is a demo connection with synthetic {selected.name} data that matches the
                sample cases. No real account is linked.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Evianta will be able to</p>
              <ul className="flex flex-col gap-2">
                {selected.scopes.map((scope) => (
                  <li key={scope} className="flex items-center gap-2 text-sm">
                    <Lock aria-hidden className="size-4 text-muted-foreground" />
                    {scope} (read only)
                  </li>
                ))}
              </ul>
              <p className="text-sm font-medium">Data it can provide</p>
              <ul className="flex flex-wrap gap-1.5">
                {selected.datasets.map((dataset) => (
                  <li key={dataset.id}>
                    <Badge variant="outline">{dataset.label}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Nothing is attached to a case until you choose it.
              </p>
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="ghost"
                onClick={() => setSelectedId(undefined)}
                disabled={Boolean(sources.connectingId)}
              >
                <ArrowLeft aria-hidden />
                All data sources
              </Button>
              <Button
                onClick={() => void connectAsync()}
                loading={sources.connectingId === selected.id}
              >
                {existing ? "Use this connection" : "Connect demo account"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Connect a source</DialogTitle>
              <DialogDescription>
                Link the apps your records live in. When a case needs something, Evianta suggests
                matching items and you choose what to attach. All connections here are demos with
                synthetic data.
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
              {categoryOrder.map((category) => (
                <section key={category} aria-label={sourceCategoryLabels[category]}>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {sourceCategoryLabels[category]}
                  </h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {sourceConnectorCatalog
                      .filter((connector) => connector.category === category)
                      .map((connector) => (
                        <li key={connector.id}>
                          <SourceTile
                            connector={connector}
                            connected={Boolean(sources.connectionFor(connector.id))}
                            onSelect={() => setSelectedId(connector.id)}
                          />
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
