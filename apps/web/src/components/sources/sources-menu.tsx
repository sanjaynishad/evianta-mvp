"use client";

import { useState } from "react";
import { Database, Plug, Settings2 } from "lucide-react";
import { findSourceConnector } from "@evianta/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSourceConnections } from "@/hooks/use-source-connections";
import { cn } from "@/lib/utils";
import { ConnectSourceDialog } from "./connect-source-dialog";
import { ManageSourcesDialog } from "./manage-sources-dialog";
import { SourceMonogram } from "./source-monogram";

export interface SourcesMenuProps {
  enabledConnectionIds: string[];
  onEnabledConnectionIdsChange: (ids: string[]) => void;
  disabled?: boolean;
  className?: string;
}

// The composer's "Sources" pill: choose which connected data sources this case may draw from.
export function SourcesMenu({
  enabledConnectionIds,
  onEnabledConnectionIdsChange,
  disabled,
  className,
}: SourcesMenuProps) {
  const sources = useSourceConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const enabled = new Set(enabledConnectionIds);
  const enabledCount = sources.connections.filter((connection) =>
    enabled.has(connection.id),
  ).length;

  function toggle(connectionId: string, checked: boolean) {
    const next = new Set(enabled);
    if (checked) {
      next.add(connectionId);
    } else {
      next.delete(connectionId);
    }

    onEnabledConnectionIdsChange([...next]);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "rounded-full",
              enabledCount > 0 && "border-primary/40 text-primary",
              className,
            )}
            aria-label={
              enabledCount > 0 ? `Sources, ${enabledCount} in use` : "Sources, choose data sources"
            }
          >
            <Database aria-hidden />
            Sources
            {enabledCount > 0 ? (
              <span className="figures rounded-full bg-primary-subtle px-1.5 text-[11px] text-primary">
                {enabledCount}
              </span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Use data from</DropdownMenuLabel>
          {sources.connections.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted-foreground">
              No data sources yet. Connect one and Evianta will suggest matching items for this
              case.
            </p>
          ) : (
            sources.connections.map((connection) => {
              const connector = findSourceConnector(connection.connectorId);
              return (
                <DropdownMenuCheckboxItem
                  key={connection.id}
                  checked={enabled.has(connection.id)}
                  onCheckedChange={(checked) => toggle(connection.id, checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex items-center gap-2">
                    <SourceMonogram connectorId={connection.connectorId} size="sm" />
                    {connector?.name ?? connection.connectorId}
                    <span className="text-xs text-muted-foreground">Demo</span>
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setConnectOpen(true)}>
            <Plug aria-hidden />
            Connect a source
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setManageOpen(true)}>
            <Settings2 aria-hidden />
            Manage data sources
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectSourceDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(connection) => {
          if (!enabled.has(connection.id)) {
            onEnabledConnectionIdsChange([...enabled, connection.id]);
          }
        }}
      />
      <ManageSourcesDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  );
}
