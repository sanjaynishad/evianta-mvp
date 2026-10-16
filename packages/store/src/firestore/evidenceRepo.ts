import { evidenceSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import type { EvidenceRepo } from "../types.js";
import { caseSubcollection, createDocAsync, listInInsertionOrderAsync } from "./helpers.js";

export function createEvidenceRepo(db: Firestore): EvidenceRepo {
  return {
    async addEvidenceAsync(caseId, input) {
      const evidence = evidenceSchema.parse(input);

      await createDocAsync(
        caseSubcollection(db, caseId, "evidence").doc(evidence.id),
        evidence,
        "evidence",
      );

      return evidence;
    },
    async getEvidenceForCaseAsync(caseId) {
      return listInInsertionOrderAsync(caseSubcollection(db, caseId, "evidence"), evidenceSchema);
    },
  };
}
