import { chatMessageSchema, type ChatMessage } from "@evianta/core";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

import { buildChatMessage, compareMessagesByCreatedAt } from "../mutations.js";
import type { ChatRepo } from "../types.js";
import { caseSubcollection, compareByInsertionOrder, createDocAsync } from "./helpers.js";

interface MessageEntry {
  message: ChatMessage;
  snapshot: QueryDocumentSnapshot;
}

export function createChatRepo(db: Firestore): ChatRepo {
  return {
    async appendMessageAsync(caseId, input) {
      const message = buildChatMessage(caseId, input);

      await createDocAsync(
        caseSubcollection(db, caseId, "messages").doc(message.id),
        message,
        "chat-message",
      );

      return message;
    },
    async listMessagesAsync(caseId) {
      const snapshot = await caseSubcollection(db, caseId, "messages").get();
      const entries: MessageEntry[] = snapshot.docs.map((doc) => ({
        message: chatMessageSchema.parse(doc.data()),
        snapshot: doc,
      }));

      return entries
        .sort(
          (left, right) =>
            compareMessagesByCreatedAt(left.message, right.message) ||
            compareByInsertionOrder(left.snapshot, right.snapshot),
        )
        .map((entry) => entry.message);
    },
  };
}
