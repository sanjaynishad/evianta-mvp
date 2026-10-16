import { caseSchema, taskSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import { StoreNotFoundError } from "../errors.js";
import { applyCaseUsageIncrement, applyTaskCharge, isLeaseHeld } from "../mutations.js";
import type { RunRepo } from "../types.js";
import { caseSubcollection, casesCollection, toFirestoreData } from "./helpers.js";
import { leaseRef, leaseSchema } from "./lease.js";

const chargeSchema = z.object({
  applied: z.boolean(),
  taskId: z.string().optional(),
  increment: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    costEstimate: z.number().nonnegative().optional(),
    runCount: z.number().int().nonnegative().optional(),
    lastRunAt: z.string().optional(),
  }),
});

export function createRunRepo(db: Firestore): RunRepo {
  const cases = casesCollection(db);

  async function claimAsync(
    caseId: string,
    owner: string,
    ttlMs: number,
    renew: boolean,
  ): Promise<boolean> {
    return db.runTransaction(async (transaction) => {
      const ref = leaseRef(db, caseId);
      const [caseSnapshot, snapshot] = await Promise.all([
        transaction.get(cases.doc(caseId)),
        transaction.get(ref),
      ]);

      if (!caseSnapshot.exists) {
        throw new StoreNotFoundError("case", caseId);
      }

      const lease = snapshot.exists ? leaseSchema.parse(snapshot.data()) : undefined;
      const active = lease !== undefined && lease.expiresAt > Date.now();

      if (renew ? !isLeaseHeld(lease, owner) : active) {
        return false;
      }

      transaction.set(ref, { owner, expiresAt: Date.now() + ttlMs });

      return true;
    });
  }

  return {
    acquireLeaseAsync: (caseId, owner, ttlMs) => claimAsync(caseId, owner, ttlMs, false),
    renewLeaseAsync: (caseId, owner, ttlMs) => claimAsync(caseId, owner, ttlMs, true),
    async releaseLeaseAsync(caseId, owner) {
      await db.runTransaction(async (transaction) => {
        const ref = leaseRef(db, caseId);
        const snapshot = await transaction.get(ref);

        if (snapshot.exists && leaseSchema.parse(snapshot.data()).owner === owner) {
          transaction.delete(ref);
        }
      });
    },
    async recordChargeAsync(caseId, runId, chargeId, { taskId, ...increment }) {
      const ref = cases
        .doc(caseId)
        .collection("runCharges")
        .doc(`${encodeURIComponent(runId)}:${encodeURIComponent(chargeId)}`);
      const charge = chargeSchema.parse({ applied: false, taskId, increment });

      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);

        if (!snapshot.exists) {
          transaction.create(ref, toFirestoreData(charge));
        }
      });
    },
    async reconcileUsageAsync(caseId) {
      const pending = await cases
        .doc(caseId)
        .collection("runCharges")
        .where("applied", "==", false)
        .get();
      let applied = 0;

      for (const charge of pending.docs) {
        const didApply = await db.runTransaction(async (transaction) => {
          const caseRef = cases.doc(caseId);
          const [caseSnapshot, chargeSnapshot] = await Promise.all([
            transaction.get(caseRef),
            transaction.get(charge.ref),
          ]);

          if (!caseSnapshot.exists) {
            throw new StoreNotFoundError("case", caseId);
          }

          const current = chargeSchema.parse(chargeSnapshot.data());

          if (current.applied) {
            return false;
          }

          const taskRef =
            current.taskId === undefined
              ? undefined
              : caseSubcollection(db, caseId, "tasks").doc(current.taskId);
          const taskSnapshot = taskRef ? await transaction.get(taskRef) : undefined;
          const updated = applyCaseUsageIncrement(
            caseSchema.parse(caseSnapshot.data()),
            current.increment,
          );

          transaction.update(caseRef, toFirestoreData(updated));

          if (taskRef && taskSnapshot?.exists) {
            const task = applyTaskCharge(taskSchema.parse(taskSnapshot.data()), current.increment);

            transaction.update(
              taskRef,
              toFirestoreData({ tokenUsage: task.tokenUsage, costEstimate: task.costEstimate }),
            );
          }

          transaction.update(charge.ref, { applied: true });

          return true;
        });

        applied += Number(didApply);
      }

      return applied;
    },
  };
}
