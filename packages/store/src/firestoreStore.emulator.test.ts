import {
  firestoreDatabaseId,
  firestoreEmulatorHost,
  gcsBucket,
  storageEmulatorHost,
} from "@evianta/env";
import { Storage } from "@google-cloud/storage";
import { getApps, initializeApp } from "firebase-admin/app";
import { describe, expect, it } from "vitest";

import { createGcsDocumentStore } from "./documents/gcsDocumentStore.js";
import { getFirestoreClient } from "./firestore/client.js";
import { createFirestoreStore } from "./firestore/firestoreStore.js";
import { describeStoreContract } from "./store.contract.js";

const projectId = "demo-evianta";
const bucketName = gcsBucket || `${projectId}.appspot.com`;
const emulatorsEnabled = firestoreEmulatorHost.length > 0 && storageEmulatorHost.length > 0;

function getTestFirestore() {
  if (getApps().length === 0) {
    initializeApp({ projectId });
  }

  return getFirestoreClient();
}

async function clearFirestoreAsync(): Promise<void> {
  const response = await fetch(
    `http://${firestoreEmulatorHost}/emulator/v1/projects/${projectId}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error(`Failed to clear the Firestore emulator: ${response.status}`);
  }
}

describe.skipIf(!emulatorsEnabled)("Firestore and Storage emulators", () => {
  describeStoreContract("firestore", async () => {
    await clearFirestoreAsync();

    return {
      store: createFirestoreStore(getTestFirestore()),
      documentStore: createGcsDocumentStore(bucketName),
    };
  });

  it("serves uploaded bytes from the unsigned emulator URL", async () => {
    const documentStore = createGcsDocumentStore(bucketName, { storage: new Storage() });
    const bytes = Buffer.from("emulator bytes");
    const gcsPath = await documentStore.uploadAsync("case-1", "bytes.txt", "text/plain", bytes);
    const url = await documentStore.getSignedUrlAsync(gcsPath);
    const response = await fetch(url);

    expect(gcsPath.startsWith(`gs://${bucketName}/`)).toBe(true);
    expect(response.ok).toBe(true);
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), bytes)).toBe(0);
  });

  it("strips undefined properties before writing", async () => {
    const store = createFirestoreStore(getTestFirestore());
    const created = await store.cases.createCaseAsync({
      title: "Undefined fields",
      useCase: "msme-payment",
      description: undefined,
      visitorId: undefined,
    });
    const raw = await getTestFirestore().collection("cases").doc(created.id).get();

    expect(Object.keys(raw.data() ?? {})).not.toContain("description");
    expect(await store.cases.getCaseAsync(created.id)).toEqual(created);
  });
});
