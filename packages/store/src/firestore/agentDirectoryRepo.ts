import { agentProfileSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";

import { compareProfilesByRole } from "../mutations.js";
import type { AgentDirectoryRepo } from "../types.js";
import { getDocAsync, toFirestoreData } from "./helpers.js";

export function createAgentDirectoryRepo(db: Firestore): AgentDirectoryRepo {
  const profiles = db.collection("agents");

  return {
    async listProfilesAsync(options) {
      const query = options?.enabledOnly ? profiles.where("enabled", "==", true) : profiles;
      const snapshot = await query.get();

      return snapshot.docs
        .map((doc) => agentProfileSchema.parse(doc.data()))
        .sort(compareProfilesByRole);
    },
    async getProfileAsync(role) {
      return getDocAsync(profiles.doc(role), agentProfileSchema);
    },
    async upsertProfileAsync(input) {
      const profile = agentProfileSchema.parse(input);

      await profiles.doc(profile.role).set(toFirestoreData(profile));

      return profile;
    },
  };
}
