import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let app: App | undefined;

export function getFirestoreClient(): Firestore {
  if (!app) {
    app = getApps()[0] ?? initializeApp();
  }

  return getFirestore(app);
}
