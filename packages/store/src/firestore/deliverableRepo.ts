import { deliverableSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { applySectionUpdate, assertDeliverableIdentity } from "../mutations.js";
import type { DeliverableRepo } from "../types.js";
import {
  caseSubcollection,
  getDocAsync,
  listInInsertionOrderAsync,
  mutateDocAsync,
  nextOrder,
  orderField,
  toFirestoreData,
  upsertDocAsync,
} from "./helpers.js";

export function createDeliverableRepo(db: Firestore): DeliverableRepo {
  return {
    async saveDeliverableAsync(input) {
      const deliverable = deliverableSchema.parse(input);
      const ref = caseSubcollection(db, deliverable.caseId, "deliverables").doc(deliverable.id);

      await upsertDocAsync(db, ref, deliverable);

      return deliverable;
    },
    async updateDeliverableAsync(caseId, deliverableId, update) {
      const ref = caseSubcollection(db, caseId, "deliverables").doc(deliverableId);

      return db.runTransaction(async (transaction) => {
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
      return mutateDocAsync(
        db,
        caseSubcollection(db, caseId, "deliverables").doc(deliverableId),
        deliverableSchema,
        "deliverable",
        (current) => applySectionUpdate(current, sectionId, update),
      );
    },
  };
}
