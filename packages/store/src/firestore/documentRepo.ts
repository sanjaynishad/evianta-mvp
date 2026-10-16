import { documentMetadataSchema, extractedDocumentSchema } from "@evianta/core";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";

import { newId, nowIso } from "../mutations.js";
import type { DocumentRepo } from "../types.js";
import {
  caseSubcollection,
  createDocAsync,
  getDocAsync,
  listInInsertionOrderAsync,
  toFirestoreData,
} from "./helpers.js";

export const extractionMetaSchema = z.object({
  documentId: z.string(),
  version: z.string(),
  chunkCount: z.number().int().nonnegative(),
  savedAt: z.string(),
});

export const extractionChunkSchema = z.object({
  documentId: z.string(),
  version: z.string(),
  index: z.number().int().nonnegative(),
  data: z.string(),
});

// Extractions are stored as chunked JSON because tables use nested arrays (unsupported by
// Firestore) and large spreadsheets can exceed the 1 MiB document limit. 250k UTF-16 units
// stay under 1 MiB of UTF-8, and 8 chunks stay under the 10 MiB batch request limit.
const chunkLength = 250_000;
const chunksPerBatch = 8;
const deletesPerBatch = 400;

function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < value.length) {
    let end = Math.min(start + chunkLength, value.length);
    const lastCode = value.charCodeAt(end - 1);

    if (end < value.length && lastCode >= 0xd800 && lastCode <= 0xdbff) {
      end -= 1;
    }

    chunks.push(value.slice(start, end));
    start = end;
  }

  return chunks;
}

function chunkDocId(version: string, index: number): string {
  return `${version}-${String(index).padStart(5, "0")}`;
}

export function createDocumentRepo(db: Firestore): DocumentRepo {
  return {
    async addDocumentMetadataAsync(input) {
      const metadata = documentMetadataSchema.parse(input);

      await createDocAsync(
        caseSubcollection(db, metadata.caseId, "documents").doc(metadata.id),
        metadata,
        "document",
      );

      return metadata;
    },
    async getDocumentsForCaseAsync(caseId) {
      return listInInsertionOrderAsync(
        caseSubcollection(db, caseId, "documents"),
        documentMetadataSchema,
      );
    },
    async getDocumentAsync(caseId, documentId) {
      return getDocAsync(
        caseSubcollection(db, caseId, "documents").doc(documentId),
        documentMetadataSchema,
      );
    },
    async saveExtractionAsync(caseId, input) {
      const extraction = extractedDocumentSchema.parse(input);
      const { documentId } = extraction;
      const chunks = splitIntoChunks(JSON.stringify(extraction));
      const version = newId();
      const chunkCollection = caseSubcollection(db, caseId, "extractionChunks");

      for (let offset = 0; offset < chunks.length; offset += chunksPerBatch) {
        const batch = db.batch();

        chunks.slice(offset, offset + chunksPerBatch).forEach((data, position) => {
          const index = offset + position;

          batch.set(chunkCollection.doc(chunkDocId(version, index)), {
            documentId,
            version,
            index,
            data,
          });
        });
        await batch.commit();
      }

      const metaRef = caseSubcollection(db, caseId, "extractions").doc(documentId);
      const supersededVersion = await db.runTransaction(async (transaction) => {
        const previous = await transaction.get(metaRef);

        transaction.set(
          metaRef,
          toFirestoreData({ documentId, version, chunkCount: chunks.length, savedAt: nowIso() }),
        );

        return previous.exists ? extractionMetaSchema.parse(previous.data()).version : undefined;
      });

      // Only the version this save replaced is removed, so concurrent uploads that have not
      // been published yet keep their chunks.
      if (supersededVersion !== undefined) {
        const superseded = await chunkCollection.where("version", "==", supersededVersion).get();

        for (let offset = 0; offset < superseded.docs.length; offset += deletesPerBatch) {
          const batch = db.batch();

          for (const doc of superseded.docs.slice(offset, offset + deletesPerBatch)) {
            batch.delete(doc.ref);
          }

          await batch.commit();
        }
      }

      return extraction;
    },
    async getExtractionAsync(caseId, documentId) {
      const metaRef = caseSubcollection(db, caseId, "extractions").doc(documentId);
      const chunkCollection = caseSubcollection(db, caseId, "extractionChunks");
      const snapshot = await db.runTransaction(
        async (transaction) => {
          const metaSnapshot = await transaction.get(metaRef);

          if (!metaSnapshot.exists) {
            return undefined;
          }

          const meta = extractionMetaSchema.parse(metaSnapshot.data());
          const chunkSnapshot = await transaction.get(
            chunkCollection.where("version", "==", meta.version),
          );

          return { meta, chunkDocs: chunkSnapshot.docs };
        },
        { readOnly: true },
      );

      if (!snapshot) {
        return undefined;
      }

      const { meta, chunkDocs } = snapshot;
      const chunks = chunkDocs
        .map((doc) => extractionChunkSchema.parse(doc.data()))
        .sort((left, right) => left.index - right.index);

      if (chunks.length !== meta.chunkCount) {
        throw new Error(`Extraction for document "${documentId}" is incomplete`);
      }

      const json: unknown = JSON.parse(chunks.map((chunk) => chunk.data).join(""));

      return extractedDocumentSchema.parse(json);
    },
  };
}
