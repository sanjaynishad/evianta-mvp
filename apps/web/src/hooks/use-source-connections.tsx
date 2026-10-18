"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { SourceConnection, SourceConnectorId } from "@evianta/core";
import { toast } from "@/components/ui/sonner";
import { useResource } from "@/hooks/use-resource";
import { trackEvent } from "@/lib/analytics";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { sourceConnectorName } from "@/lib/sources";

export interface SourceConnections {
  connections: SourceConnection[];
  loaded: boolean;
  connectingId: SourceConnectorId | undefined;
  connectionFor: (connectorId: SourceConnectorId) => SourceConnection | undefined;
  connectAsync: (connectorId: SourceConnectorId) => Promise<SourceConnection | undefined>;
  disconnectAsync: (connectionId: string) => Promise<void>;
  reload: () => void;
}

const SourceConnectionsContext = createContext<SourceConnections | null>(null);

function useSourceConnectionsState(enabled: boolean): SourceConnections {
  const dataSource = useDataSource();
  const resource = useResource(enabled ? "source-connections" : null, () =>
    dataSource.listSourceConnectionsAsync(),
  );
  const [connectingId, setConnectingId] = useState<SourceConnectorId>();
  const connections = resource.data ?? [];

  async function connectAsync(connectorId: SourceConnectorId) {
    setConnectingId(connectorId);
    try {
      const connection = await dataSource.connectSourceAsync(connectorId);
      resource.mutate((current) =>
        current.some((existing) => existing.id === connection.id)
          ? current
          : [...current, connection],
      );
      if (!resource.data) {
        resource.reload();
      }

      trackEvent("source_connected", { connector: connectorId });
      toast.success(`${sourceConnectorName(connectorId)} connected`, {
        description: "Demo connection with synthetic data.",
      });
      return connection;
    } catch (error) {
      toast.error(`Could not connect ${sourceConnectorName(connectorId)}`, {
        description: describeError(error),
      });
      return undefined;
    } finally {
      setConnectingId(undefined);
    }
  }

  async function disconnectAsync(connectionId: string) {
    try {
      await dataSource.disconnectSourceAsync(connectionId);
      resource.mutate((current) => current.filter((connection) => connection.id !== connectionId));
    } catch (error) {
      toast.error("Could not disconnect the data source", { description: describeError(error) });
    }
  }

  return {
    connections,
    loaded: resource.data !== undefined,
    connectingId,
    connectionFor: (connectorId) =>
      connections.find((connection) => connection.connectorId === connectorId),
    connectAsync,
    disconnectAsync,
    reload: resource.reload,
  };
}

export function SourceConnectionsProvider({ children }: { children: ReactNode }) {
  const value = useSourceConnectionsState(true);
  return (
    <SourceConnectionsContext.Provider value={value}>{children}</SourceConnectionsContext.Provider>
  );
}

// Shared through the provider when present, so every Sources menu sees the same connections.
export function useSourceConnections(): SourceConnections {
  const shared = useContext(SourceConnectionsContext);
  const local = useSourceConnectionsState(shared === null);
  return shared ?? local;
}
