import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import { StoreLeaseLostError } from "../errors.js";
import { isLeaseHeld } from "../mutations.js";
import type { LeaseFence } from "../types.js";
import { casesCollection, type TransactionGuard } from "./helpers.js";

export const leaseSchema = z.object({ owner: z.string(), expiresAt: z.number() });

export function leaseRef(db: Firestore, caseId: string) {
  return casesCollection(db).doc(caseId).collection("runState").doc("lease");
}

/**
 * Reads the lease inside the write's transaction, so a takeover that commits first makes the
 * write fail and a takeover that commits later conflicts with it.
 */
export function leaseGuard(
  db: Firestore,
  caseId: string,
  fence: LeaseFence | undefined,
): TransactionGuard | undefined {
  if (!fence) {
    return undefined;
  }

  return async (transaction) => {
    const snapshot = await transaction.get(leaseRef(db, caseId));
    const lease = snapshot.exists ? leaseSchema.parse(snapshot.data()) : undefined;

    if (!isLeaseHeld(lease, fence.leaseOwner)) {
      throw new StoreLeaseLostError(caseId, fence.leaseOwner);
    }
  };
}
