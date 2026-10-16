import { deliverableSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { applySectionUpdate } from "../mutations.js";
import type { DeliverableRepo } from "../types.js";
import {
  caseSubcollection,
  getDocAsync,
  listInInsertionOrderAsync,
  mutateDocAsync,
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
