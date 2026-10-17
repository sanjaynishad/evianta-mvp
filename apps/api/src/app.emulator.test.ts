import { createOrchestrator } from "@evianta/agents";
import { createMockAi } from "@evianta/ai";
import { firestoreEmulatorHost, gcsBucket, storageEmulatorHost } from "@evianta/env";
import { createFirestoreStore, createGcsDocumentStore, getFirestoreClient } from "@evianta/store";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { silentApiLogger } from "./logger.js";
import {
  asText,
  finding,
  SALES_CSV,
  specialistStep,
  sseFramesOf,
  VISITOR_A,
} from "./testing/harness.js";

const projectId = "demo-evianta";
const emulatorsEnabled = firestoreEmulatorHost.length > 0 && storageEmulatorHost.length > 0;

describe.skipIf(!emulatorsEnabled)("API against the Firestore and Storage emulators", () => {
  it("drives a case lifecycle end to end", async () => {
    const store = createFirestoreStore(getFirestoreClient());
    const documentStore = createGcsDocumentStore(gcsBucket || `${projectId}.appspot.com`);
    const ai = createMockAi({});
    const orchestrator = createOrchestrator({ store, ai });
    const app = createApp({
      store,
      documentStore,
      ai,
      orchestrator,
      logger: silentApiLogger,
      config: { sseHeartbeatMs: 200 },
    });
    const visitorId = `${VISITOR_A}-${Date.now()}`;

    const created = await request(app)
      .post("/cases")
      .set("X-Evianta-Visitor", visitorId)
      .send({ title: "Emulator sales review", useCase: "data-analysis" })
      .expect(201);
    const caseId = created.body.id as string;
    const upload = await request(app)
      .post(`/cases/${caseId}/documents`)
      .attach("files", Buffer.from(SALES_CSV), { filename: "sales.csv", contentType: "text/csv" })
      .expect(201);
    const documentId = upload.body.documents[0].id as string;

    await app.idleAsync();

    const file = await request(app)
      .get(`/cases/${caseId}/documents/${documentId}/file`)
      .expect(200);

    expect(file.text).toBe(SALES_CSV);

    ai.script(
      "business-data-analyst",
      specialistStep(
        [
          finding("March revenue peaked", {
            evidence: [{ documentId, description: "March row", rowStart: 4 }],
          }),
        ],
        { title: "Revenue trend", content: "Revenue peaked in March." },
      ),
    );

    const run = await request(app).post(`/cases/${caseId}/run`).expect(202);
    const frames = sseFramesOf(
      await asText(request(app).get(`/cases/${caseId}/stream`)).expect(200),
    );

    expect(frames.map((frame) => Number(frame.id))).toEqual(frames.map((_, index) => index + 1));
    expect(frames.at(-1)).toMatchObject({
      event: "run-completed",
      data: { runId: run.body.runId },
    });

    await app.idleAsync();

    const resumed = sseFramesOf(
      await asText(
        request(app)
          .get(`/cases/${caseId}/stream`)
          .set("Last-Event-ID", String(frames.length - 1)),
      ).expect(200),
    );

    expect(resumed.map((frame) => frame.event)).toEqual(["run-completed"]);

    const state = await request(app).get(`/cases/${caseId}`).expect(200);
    const listed = await request(app).get("/cases").set("X-Evianta-Visitor", visitorId).expect(200);
    const deliverable = await request(app)
      .get(`/cases/${caseId}/deliverables/deliverable-primary`)
      .expect(200);

    expect(state.body.case.status).toBe("completed");
    expect(state.body.documents[0]).toMatchObject({ status: "ready" });
    expect(state.body.evidence).toEqual([expect.objectContaining({ documentId })]);
    expect(listed.body.cases.map((item: { id: string }) => item.id)).toEqual([caseId]);
    expect(deliverable.body.sections[0]).toMatchObject({ content: "Revenue peaked in March." });
  });
});
