import { sourceConnectionSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { StoreConflictError } from "../errors.js";
import { applyConnectionImport, compareConnectionsOldestFirst } from "../mutations.js";
import type { SourceConnectionRepo } from "../types.js";
import { getDocAsync, isAlreadyExistsError, mutateDocAsync, toFirestoreData } from "./helpers.js";

export function createSourceConnectionRepo(db: Firestore): SourceConnectionRepo {
  const connections = db.collection("sourceConnections");

  return {
    async createConnectionAsync(input) {
      const connection = sourceConnectionSchema.parse(input);

      try {
        await connections.doc(connection.id).create(toFirestoreData(connection));
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new StoreConflictError("source-connection", connection.id);
        }

        throw error;
      }

      return connection;
    },
    // Sorted in memory so the equality filter needs no composite index.
    async listConnectionsForVisitorAsync(visitorId) {
      const snapshot = await connections.where("visitorId", "==", visitorId).get();

      return snapshot.docs
        .map((doc) => sourceConnectionSchema.parse(doc.data()))
        .sort(compareConnectionsOldestFirst);
    },
    async getConnectionAsync(connectionId) {
      return getDocAsync(connections.doc(connectionId), sourceConnectionSchema);
    },
    async deleteConnectionAsync(connectionId) {
      await connections.doc(connectionId).delete();
    },
    async touchConnectionAsync(connectionId, lastImportAt) {
      return mutateDocAsync(
        db,
        connections.doc(connectionId),
        sourceConnectionSchema,
        "source-connection",
        (current) => applyConnectionImport(current, lastImportAt),
      );
    },
  };
}
