import {
  caseSchema,
  deliverableSchema,
  documentMetadataSchema,
  evidenceSchema,
  findingSchema,
  runEventSchema,
  taskSchema,
} from "@evianta/core";
import type { DocumentData, Firestore } from "firebase-admin/firestore";

import { StoreConflictError, StoreNotFoundError } from "../errors.js";
import {
  applyCaseApproval,
  applyCaseStatus,
  applyCaseUsageIncrement,
  buildCaseCopy,
  buildNewCase,
  compareCasesNewestFirst,
  clearCaseApproval,
  resolvePageSize,
} from "../mutations.js";
import type { CaseRepo } from "../types.js";
import { extractionChunkSchema, extractionMetaSchema } from "./documentRepo.js";
import {
  caseSubcollection,
  casesCollection,
  getDocAsync,
  isAlreadyExistsError,
  mutateDocAsync,
  orderField,
  toFirestoreData,
  type CaseSubcollection,
} from "./helpers.js";

type CopyTransform = (data: DocumentData, targetCaseId: string) => object;

const copyTransforms: Record<CaseSubcollection, CopyTransform> = {
  tasks: (data, caseId) => ({ ...taskSchema.parse(data), caseId }),
  findings: (data) => findingSchema.parse(data),
  evidence: (data) => evidenceSchema.parse(data),
  deliverables: (data, caseId) => ({ ...deliverableSchema.parse(data), caseId }),
  documents: (data, caseId) => ({ ...documentMetadataSchema.parse(data), caseId }),
  extractions: (data) => extractionMetaSchema.parse(data),
  extractionChunks: (data) => extractionChunkSchema.parse(data),
  events: (data, caseId) => ({ ...runEventSchema.parse(data), caseId }),
};

const copiedSubcollections = Object.keys(copyTransforms) as CaseSubcollection[];

export function createCaseRepo(db: Firestore): CaseRepo {
  const cases = casesCollection(db);

  return {
    async createCaseAsync(input) {
      const created = buildNewCase(input);

      try {
        await cases.doc(created.id).create(toFirestoreData(created));
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new StoreConflictError("case", created.id);
        }

        throw error;
      }

      return created;
    },
    async getCaseAsync(caseId) {
      return getDocAsync(cases.doc(caseId), caseSchema);
    },
    async listCasesForVisitorAsync(visitorId) {
      const snapshot = await cases.where("visitorId", "==", visitorId).get();

      return snapshot.docs
        .map((doc) => caseSchema.parse(doc.data()))
        .filter((item) => !item.isSample)
        .sort(compareCasesNewestFirst);
    },
    async listSampleCasesAsync() {
      const snapshot = await cases.where("isSample", "==", true).get();

      return snapshot.docs.map((doc) => caseSchema.parse(doc.data())).sort(compareCasesNewestFirst);
    },
    async listAllCasesAsync(options) {
      const pageSize = resolvePageSize(options);
      let query = cases.orderBy("createdAt", "desc");

      if (options?.cursor !== undefined) {
        const cursor = await cases.doc(options.cursor).get();

        if (!cursor.exists) {
          throw new StoreNotFoundError("case", options.cursor);
        }

        query = query.startAfter(cursor);
      }

      const snapshot = await query.limit(pageSize + 1).get();
      const page = snapshot.docs.slice(0, pageSize).map((doc) => caseSchema.parse(doc.data()));
      const hasMore = snapshot.docs.length > pageSize;

      return { cases: page, nextCursor: hasMore ? page.at(-1)?.id : undefined };
    },
    async updateCaseStatusAsync(caseId, status) {
      return mutateDocAsync(db, cases.doc(caseId), caseSchema, "case", (current) =>
        applyCaseStatus(current, status),
      );
    },
    async updateCaseUsageAsync(caseId, increment) {
      return mutateDocAsync(db, cases.doc(caseId), caseSchema, "case", (current) =>
        applyCaseUsageIncrement(current, increment),
      );
    },
    async recordApprovalAsync(caseId, approval) {
      return mutateDocAsync(db, cases.doc(caseId), caseSchema, "case", (current) =>
        applyCaseApproval(current, approval),
      );
    },
    async clearApprovalAsync(caseId) {
      return mutateDocAsync(db, cases.doc(caseId), caseSchema, "case", clearCaseApproval);
    },
    async copyCaseAsync(sourceCaseId, visitorId) {
      const source = await getDocAsync(cases.doc(sourceCaseId), caseSchema);

      if (!source) {
        throw new StoreNotFoundError("case", sourceCaseId);
      }

      const copy = buildCaseCopy(source, visitorId);
      // One read-only transaction gives every subcollection the same snapshot, so a concurrent
      // extraction replacement cannot pair one version's metadata with another version's chunks.
      const sourceSnapshots = await db.runTransaction(
        (transaction) =>
          Promise.all(
            copiedSubcollections.map(async (name) => ({
              name,
              docs: (await transaction.get(caseSubcollection(db, sourceCaseId, name))).docs,
            })),
          ),
        { readOnly: true },
      );
      const writer = db.bulkWriter();
      const failures: unknown[] = [];

      for (const { name, docs } of sourceSnapshots) {
        const target = caseSubcollection(db, copy.id, name);

        for (const doc of docs) {
          const data = copyTransforms[name](doc.data(), copy.id);

          writer
            .set(
              target.doc(doc.id),
              toFirestoreData({ ...data, [orderField]: doc.get(orderField) }),
            )
            .catch((error: unknown) => {
              failures.push(error);
            });
        }
      }

      await writer.close();

      if (failures.length > 0) {
        throw failures[0];
      }

      // The case document is written last so a partially copied case never becomes visible.
      await cases.doc(copy.id).create(toFirestoreData(copy));

      return copy;
    },
  };
}
