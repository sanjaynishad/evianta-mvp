import type { Firestore } from "firebase-admin/firestore";

import type { Store } from "../types.js";
import { createAgentDirectoryRepo } from "./agentDirectoryRepo.js";
import { createCaseRepo } from "./caseRepo.js";
import { createDeliverableRepo } from "./deliverableRepo.js";
import { createDocumentRepo } from "./documentRepo.js";
import { createEventRepo } from "./eventRepo.js";
import { createEvidenceRepo } from "./evidenceRepo.js";
import { createFindingRepo } from "./findingRepo.js";
import { createTaskRepo } from "./taskRepo.js";
import { createRunRepo } from "./runRepo.js";

export function createFirestoreStore(db: Firestore): Store {
  return {
    agents: createAgentDirectoryRepo(db),
    cases: createCaseRepo(db),
    tasks: createTaskRepo(db),
    findings: createFindingRepo(db),
    evidence: createEvidenceRepo(db),
    deliverables: createDeliverableRepo(db),
    documents: createDocumentRepo(db),
    events: createEventRepo(db),
    runs: createRunRepo(db),
  };
}
