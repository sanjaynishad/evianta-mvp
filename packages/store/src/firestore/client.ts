import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let firestore: Firestore | undefined;

export function getFirestoreClient(): Firestore {
  if (!firestore) {
    const app = getApps()[0] ?? initializeApp();
    const client = getFirestore(app);

    try {
      client.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Settings can only be applied before first use; repositories strip undefined values anyway.
    }

    firestore = client;
  }

  return firestore;
}
