import { runEventSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { buildRunEvent } from "../mutations.js";
import type { EventRepo } from "../types.js";
import { caseSubcollection, toFirestoreData } from "./helpers.js";

export function eventDocId(seq: number): string {
  return String(seq).padStart(10, "0");
}

export function createEventRepo(db: Firestore): EventRepo {
  return {
    async appendEventAsync(caseId, input) {
      const events = caseSubcollection(db, caseId, "events");

      return db.runTransaction(async (transaction) => {
        const latest = await transaction.get(events.orderBy("seq", "desc").limit(1));
        const latestSeq: unknown = latest.docs[0]?.get("seq");
        const seq = (typeof latestSeq === "number" ? latestSeq : 0) + 1;
        const event = buildRunEvent(caseId, seq, input);

        transaction.create(events.doc(eventDocId(seq)), toFirestoreData(event));

        return event;
      });
    },
    async listEventsAsync(caseId, afterSeq = 0) {
      const snapshot = await caseSubcollection(db, caseId, "events")
        .where("seq", ">", afterSeq)
        .orderBy("seq")
        .get();

      return snapshot.docs.map((doc) => runEventSchema.parse(doc.data()));
    },
  };
}
