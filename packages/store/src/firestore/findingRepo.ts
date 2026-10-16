import { findingSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { StoreNotFoundError } from "../errors.js";
import { applyOpenQuestionUpdate, findingHasQuestion } from "../mutations.js";
import type { FindingRepo } from "../types.js";
import {
  caseSubcollection,
  createDocAsync,
  listInInsertionOrderAsync,
  orderField,
  toFirestoreData,
} from "./helpers.js";

export function createFindingRepo(db: Firestore): FindingRepo {
  return {
    async addFindingAsync(caseId, input) {
      const finding = findingSchema.parse(input);

      await createDocAsync(
        caseSubcollection(db, caseId, "findings").doc(finding.id),
        finding,
        "finding",
      );

      return finding;
    },
    async getFindingsForCaseAsync(caseId) {
      return listInInsertionOrderAsync(caseSubcollection(db, caseId, "findings"), findingSchema);
    },
    async updateOpenQuestionAsync(caseId, questionId, update) {
      const findings = caseSubcollection(db, caseId, "findings");

      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(findings);

        for (const doc of snapshot.docs) {
          const finding = findingSchema.parse(doc.data());

          if (!findingHasQuestion(finding, questionId)) {
            continue;
          }

          const next = applyOpenQuestionUpdate(finding, questionId, update);

          transaction.set(doc.ref, toFirestoreData({ ...next, [orderField]: doc.get(orderField) }));

          return next;
        }

        throw new StoreNotFoundError("open-question", questionId);
      });
    },
  };
}
