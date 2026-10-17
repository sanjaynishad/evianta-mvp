import { deliverableSchema } from "@evianta/core";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { StoreNotFoundError } from "../errors.js";
import { applySectionUpdate, assertDeliverableIdentity } from "../mutations.js";
import type { DeliverableRepo } from "../types.js";
import {
  caseSubcollection,
  casesCollection,
  getDocAsync,
  listInInsertionOrderAsync,
  nextOrder,
  orderField,
  toFirestoreData,
  upsertDocAsync,
} from "./helpers.js";
import { leaseGuard } from "./lease.js";

export function createDeliverableRepo(db: Firestore): DeliverableRepo {
  return {
    async saveDeliverableAsync(input) {
      const deliverable = deliverableSchema.parse(input);
      const ref = caseSubcollection(db, deliverable.caseId, "deliverables").doc(deliverable.id);

      await upsertDocAsync(db, ref, deliverable);

      return deliverable;
    },
    async updateDeliverableAsync(caseId, deliverableId, update, fence) {
      const ref = caseSubcollection(db, caseId, "deliverables").doc(deliverableId);
      const guard = leaseGuard(db, caseId, fence);

      return db.runTransaction(async (transaction) => {
        await guard?.(transaction);
        const snapshot = await transaction.get(ref);
        const current = snapshot.exists ? deliverableSchema.parse(snapshot.data()) : undefined;
        const input = update(current);

        if (input === undefined) {
          return current;
        }

        const next = deliverableSchema.parse(input);
        const existingOrder: unknown = snapshot.exists ? snapshot.get(orderField) : undefined;

        assertDeliverableIdentity(next, caseId, deliverableId);
        transaction.set(
          ref,
          toFirestoreData({
            ...next,
            [orderField]: typeof existingOrder === "number" ? existingOrder : nextOrder(),
          }),
        );

        return next;
      });
    },
    async getDeliverablesForCaseAsync(caseId) {
      return listInInsertionOrderAsync(
        caseSubcollection(db, caseId, "deliverables"),
        deliverableSchema,
      );
    },
    async getDeliverableAsync(caseId, deliverableId) {
      return getDocAsync(
        caseSubcollection(db, caseId, "deliverables").doc(deliverableId),
        deliverableSchema,
      );
    },
    async updateSectionAsync(caseId, deliverableId, sectionId, update) {
      const ref = caseSubcollection(db, caseId, "deliverables").doc(deliverableId);
      const caseRef = casesCollection(db).doc(caseId);

      return db.runTransaction(async (transaction) => {
        const [snapshot, caseSnapshot] = await Promise.all([
          transaction.get(ref),
          transaction.get(caseRef),
        ]);

        if (!snapshot.exists) {
          throw new StoreNotFoundError("deliverable", deliverableId);
        }

        const next = applySectionUpdate(
          deliverableSchema.parse(snapshot.data()),
          sectionId,
          update,
        );

        transaction.update(ref, toFirestoreData(next));

        if (update.editedContent !== undefined && caseSnapshot.exists) {
          transaction.update(caseRef, {
            approval: FieldValue.delete(),
            updatedAt: new Date().toISOString(),
          });
        }

        return next;
      });
    },
  };
}
