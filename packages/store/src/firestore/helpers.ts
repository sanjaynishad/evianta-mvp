import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import type { z } from "zod";

import { StoreConflictError, StoreNotFoundError, type StoreEntity } from "../errors.js";

export type EntitySchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** Runs first inside a write transaction and throws to abort the write. */
export type TransactionGuard = (transaction: Transaction) => Promise<void>;

export type CaseSubcollection =
  | "tasks"
  | "findings"
  | "evidence"
  | "deliverables"
  | "documents"
  | "extractions"
  | "extractionChunks"
  | "events";

// Hidden field that keeps case-scoped lists in insertion order; schema parsing strips it on read.
export const orderField = "_order";

const alreadyExistsCode = 6;

let lastOrder = 0;

export function nextOrder(): number {
  lastOrder = Math.max(Date.now() * 1000, lastOrder + 1);

  return lastOrder;
}

export function casesCollection(db: Firestore): CollectionReference {
  return db.collection("cases");
}

export function caseSubcollection(
  db: Firestore,
  caseId: string,
  name: CaseSubcollection,
): CollectionReference {
  return casesCollection(db).doc(caseId).collection(name);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map(stripUndefined);
  }

  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }

  return value;
}

export function toFirestoreData(value: object): DocumentData {
  return stripUndefined(value) as DocumentData;
}

function readOrder(snapshot: QueryDocumentSnapshot): number {
  const order: unknown = snapshot.get(orderField);

  return typeof order === "number" ? order : 0;
}

export function compareByInsertionOrder(
  left: QueryDocumentSnapshot,
  right: QueryDocumentSnapshot,
): number {
  const difference = readOrder(left) - readOrder(right);

  if (difference !== 0) {
    return difference;
  }

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export async function listInInsertionOrderAsync<T>(
  collection: CollectionReference,
  schema: EntitySchema<T>,
): Promise<T[]> {
  const snapshot = await collection.get();

  return snapshot.docs.sort(compareByInsertionOrder).map((doc) => schema.parse(doc.data()));
}

export async function getDocAsync<T>(
  ref: DocumentReference,
  schema: EntitySchema<T>,
): Promise<T | undefined> {
  const snapshot = await ref.get();

  return snapshot.exists ? schema.parse(snapshot.data()) : undefined;
}

export function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === alreadyExistsCode
  );
}

export async function createDocAsync(
  ref: DocumentReference,
  value: object,
  entity: StoreEntity,
  guard?: TransactionGuard,
): Promise<void> {
  if (guard) {
    await ref.firestore.runTransaction(async (transaction) => {
      await guard(transaction);

      if ((await transaction.get(ref)).exists) {
        throw new StoreConflictError(entity, ref.id);
      }

      transaction.create(ref, toFirestoreData({ ...value, [orderField]: nextOrder() }));
    });

    return;
  }

  try {
    await ref.create(toFirestoreData({ ...value, [orderField]: nextOrder() }));
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new StoreConflictError(entity, ref.id);
    }

    throw error;
  }
}

export async function upsertDocAsync(
  db: Firestore,
  ref: DocumentReference,
  value: object,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existingOrder: unknown = snapshot.exists ? snapshot.get(orderField) : undefined;
    const order = typeof existingOrder === "number" ? existingOrder : nextOrder();

    transaction.set(ref, toFirestoreData({ ...value, [orderField]: order }));
  });
}

export async function mutateDocAsync<T extends object>(
  db: Firestore,
  ref: DocumentReference,
  schema: EntitySchema<T>,
  entity: StoreEntity,
  mutate: (current: T) => T,
  guard?: TransactionGuard,
): Promise<T> {
  return db.runTransaction(async (transaction) => {
    await guard?.(transaction);
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      throw new StoreNotFoundError(entity, ref.id);
    }

    const next = mutate(schema.parse(snapshot.data()));

    transaction.set(ref, toFirestoreData({ ...next, [orderField]: snapshot.get(orderField) }));

    return next;
  });
}
