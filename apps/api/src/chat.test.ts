import { INTAKE_AGENT_KEY } from "@evianta/agents";
import { untitledChatTitle } from "@evianta/core";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  asText,
  createTestHarness,
  parseSseFrames,
  seedSampleAsync,
  VISITOR_A,
  VISITOR_B,
} from "./testing/harness.js";

const VISITOR_HEADER = "X-Evianta-Visitor";

function intakeStep(overrides: Record<string, unknown> = {}) {
  return {
    output: {
      useCase: "tax-notice",
      switchRequested: false,
      supported: true,
      title: "Reply to 143(1) intimation for AY 2025-26",
      description: "Respond to the CPC intimation proposing a TDS adjustment.",
      reply: "This looks like an income-tax notice response. Share the notice and Form 26AS.",
      clarifications: [{ text: "Which assessment year is the notice for?", kind: "text" }],
      ...overrides,
    },
    usage: { input: 400, output: 120 },
  };
}

async function createChatCaseAsync(app: Parameters<typeof request>[0]) {
  const response = await request(app)
    .post("/cases")
    .set(VISITOR_HEADER, VISITOR_A)
    .send({ title: untitledChatTitle, intakeMode: "chat" })
    .expect(201);

  return response.body as { id: string; intake: { mode: string }; useCase?: string };
}

async function sendMessageAsync(
  app: Parameters<typeof request>[0],
  caseId: string,
  body: Record<string, unknown>,
) {
  const response = await asText(
    request(app).post(`/cases/${caseId}/messages`).set(VISITOR_HEADER, VISITOR_A).send(body),
  ).expect(200);

  return parseSseFrames(response.body as string);
}

describe("chat intake over HTTP", () => {
  it("creates a chat case without a use case and refuses to run it", async () => {
    const { app } = createTestHarness();
    const created = await createChatCaseAsync(app);

    expect(created.intake.mode).toBe("chat");
    expect(created.useCase).toBeUndefined();

    const run = await request(app).post(`/cases/${created.id}/run`).expect(422);

    expect(run.body.error).toBe("use-case-missing");
  });

  it("classifies the request, retitles the case, and stores both messages", async () => {
    const { app, store } = createTestHarness({ script: { [INTAKE_AGENT_KEY]: intakeStep() } });
    const created = await createChatCaseAsync(app);
    const frames = await sendMessageAsync(app, created.id, {
      text: "I got a 143(1) intimation about a TDS mismatch",
    });
    const events = frames.map((frame) => frame.event);

    expect(events[0]).toBe("user-message");
    expect(events).toContain("reply-delta");
    expect(events.at(-1)).toBe("reply");

    const reply = frames.at(-1)?.data as {
      message: { role: string; parts: { type: string }[]; generatedBy: string };
      case: { useCase: string; title: string; intake: { clarifications: { text: string }[] } };
    };

    expect(reply.message.role).toBe("assistant");
    expect(reply.message.generatedBy).toBe("model");
    expect(reply.message.parts.map((part) => part.type)).toEqual(["text", "intake-request"]);
    expect(reply.case.useCase).toBe("tax-notice");
    expect(reply.case.title).toBe("Reply to 143(1) intimation for AY 2025-26");
    expect(reply.case.intake.clarifications.map((entry) => entry.text)).toEqual([
      "Which assessment year is the notice for?",
    ]);

    const messages = await request(app).get(`/cases/${created.id}/messages`).expect(200);

    expect(messages.body.messages).toHaveLength(2);
    expect((await store.cases.getCaseAsync(created.id))?.usage?.inputTokens).toBe(400);
  });

  it("falls back to rules when the model is unavailable and offers the kinds of work", async () => {
    const { app } = createTestHarness();
    const created = await createChatCaseAsync(app);
    const frames = await sendMessageAsync(app, created.id, { text: "hello" });
    const reply = frames.at(-1)?.data as {
      message: { parts: { type: string }[]; generatedBy: string };
    };

    expect(reply.message.generatedBy).toBe("rules");
    expect(reply.message.parts.map((part) => part.type)).toEqual(["text", "use-case-choice"]);
  });

  it("keeps every setup message so later corrections reach the agents", async () => {
    const { app, store } = createTestHarness();
    const created = await createChatCaseAsync(app);

    await sendMessageAsync(app, created.id, { text: "Reply to my 143(1) notice for AY 2024-25" });
    await sendMessageAsync(app, created.id, { text: " Correction: it is AY 2025-26 " });

    expect((await store.cases.getCaseAsync(created.id))?.intake?.requestMessages).toEqual([
      "Reply to my 143(1) notice for AY 2024-25",
      "Correction: it is AY 2025-26",
    ]);
  });

  it("keeps a confirmed use case when a later message is off topic", async () => {
    const { app } = createTestHarness({
      script: {
        [INTAKE_AGENT_KEY]: [
          intakeStep(),
          intakeStep({
            useCase: null,
            supported: false,
            reply: "I can only help with three things.",
          }),
        ],
      },
    });
    const created = await createChatCaseAsync(app);

    await sendMessageAsync(app, created.id, { text: "Reply to my 143(1) intimation" });

    const frames = await sendMessageAsync(app, created.id, { text: "Also write me a poem" });
    const reply = frames.at(-1)?.data as {
      case: { useCase: string; intake: { supported: boolean } };
    };

    expect(reply.case.useCase).toBe("tax-notice");
    expect(reply.case.intake.supported).toBe(true);
  });

  it("updates details and intake only while the case is a draft", async () => {
    const { app } = createTestHarness();
    const created = await createChatCaseAsync(app);
    const patched = await request(app)
      .patch(`/cases/${created.id}`)
      .send({ useCase: "msme-payment", title: "Claim against Apex Retail" })
      .expect(200);

    expect(patched.body).toMatchObject({
      useCase: "msme-payment",
      title: "Claim against Apex Retail",
    });

    const skipped = await request(app)
      .patch(`/cases/${created.id}/intake`)
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ skipItem: { itemId: "udyam", skipped: true }, mode: "form" })
      .expect(200);

    expect(skipped.body.intake).toMatchObject({
      skippedItemIds: ["udyam"],
      mode: "form",
      switchedFrom: "chat",
    });

    await request(app).patch(`/cases/${created.id}`).send({}).expect(400);
  });

  it("records the run in the chat and marks the intake as submitted", async () => {
    const { app, store } = createTestHarness();
    const created = await createChatCaseAsync(app);

    await request(app).patch(`/cases/${created.id}`).send({ useCase: "data-analysis" }).expect(200);

    const run = await request(app).post(`/cases/${created.id}/run`).expect(202);

    await app.idleAsync();

    const messages = await store.chat.listMessagesAsync(created.id);
    const runPart = messages.at(-1)?.parts[0];

    expect(runPart).toMatchObject({ type: "run", runId: run.body.runId, mode: "run" });
    expect((await store.cases.getCaseAsync(created.id))?.intake?.stage).toBe("submitted");
  });

  it("does not let a sample case receive messages", async () => {
    const { app, store } = createTestHarness();
    const sample = await seedSampleAsync(store);

    await request(app)
      .post(`/cases/${sample.id}/messages`)
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ text: "hello" })
      .expect(409);
  });
});

describe("data sources over HTTP", () => {
  it("reports cases and submissions by entry mode on the usage view", async () => {
    const { app } = createTestHarness({ config: { usageViewPath: "usage-test" } });

    await createChatCaseAsync(app);
    await request(app)
      .post("/cases")
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ title: "Form case", useCase: "data-analysis" })
      .expect(201);

    const summary = await request(app).get("/usage-test/summary").expect(200);

    expect(summary.body.byIntakeMode).toMatchObject({
      chat: { cases: 1, submitted: 0, switchedIn: 0 },
      form: { cases: 1, submitted: 0, switchedIn: 0 },
    });
  });

  it("lists the catalog and scopes connections to the visitor", async () => {
    const { app } = createTestHarness();
    const catalog = await request(app).get("/sources/catalog").expect(200);

    expect(catalog.body.connectors.map((connector: { id: string }) => connector.id)).toContain(
      "tally",
    );

    const connected = await request(app)
      .post("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ connectorId: "tally" })
      .expect(201);
    const again = await request(app)
      .post("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ connectorId: "tally" })
      .expect(200);

    expect(again.body.id).toBe(connected.body.id);

    const mine = await request(app)
      .get("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_A)
      .expect(200);
    const theirs = await request(app)
      .get("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_B)
      .expect(200);

    expect(mine.body.connections).toHaveLength(1);
    expect(theirs.body.connections).toHaveLength(0);

    await request(app)
      .delete(`/sources/connections/${connected.body.id}`)
      .set(VISITOR_HEADER, VISITOR_B)
      .expect(404);
    await request(app)
      .delete(`/sources/connections/${connected.body.id}`)
      .set(VISITOR_HEADER, VISITOR_A)
      .expect(204);
  });

  it("proposes items for missing checklist items and attaches them with provenance", async () => {
    const { app } = createTestHarness();
    const created = await createChatCaseAsync(app);

    await request(app).patch(`/cases/${created.id}`).send({ useCase: "msme-payment" }).expect(200);

    const connection = await request(app)
      .post("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ connectorId: "tally" })
      .expect(201);
    const enabled = await request(app)
      .patch(`/cases/${created.id}/intake`)
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ enabledConnectionIds: [connection.body.id, "not-mine"] })
      .expect(200);
    const proposals = enabled.body.intake.proposals as {
      id: string;
      checklistItemId: string;
      status: string;
    }[];

    expect(enabled.body.intake.enabledConnectionIds).toEqual([connection.body.id]);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((proposal) => proposal.checklistItemId === "statement")).toBe(true);

    const attached = await request(app)
      .post(`/cases/${created.id}/sources/proposals`)
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ action: "attach", proposalIds: [proposals[0]?.id] })
      .expect(201);

    expect(attached.body.documents[0].provenance).toMatchObject({
      connectorId: "tally",
      connectionId: connection.body.id,
    });
    expect(
      attached.body.case.intake.proposals.find(
        (proposal: { id: string }) => proposal.id === proposals[0]?.id,
      ).status,
    ).toBe("attached");
    expect(Object.values(attached.body.case.intake.documentItems)).toContain("statement");
  });

  it("imports a browsed item and refuses connections owned by another visitor", async () => {
    const { app } = createTestHarness();
    const created = await createChatCaseAsync(app);

    await request(app).patch(`/cases/${created.id}`).send({ useCase: "tax-notice" }).expect(200);

    const connection = await request(app)
      .post("/sources/connections")
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ connectorId: "google-drive" })
      .expect(201);
    const items = await request(app)
      .get(`/sources/connections/${connection.body.id}/items`)
      .set(VISITOR_HEADER, VISITOR_A)
      .expect(200);
    const form26as = items.body.items.find((item: { id: string }) => item.id === "form-26as");

    const imported = await request(app)
      .post(`/cases/${created.id}/sources/import`)
      .set(VISITOR_HEADER, VISITOR_A)
      .send({ connectionId: connection.body.id, itemId: form26as.id, checklistItemId: "form-26as" })
      .expect(201);

    expect(imported.body.documents[0]).toMatchObject({ mimeType: "application/pdf" });

    await request(app)
      .post(`/cases/${created.id}/sources/import`)
      .set(VISITOR_HEADER, VISITOR_B)
      .send({ connectionId: connection.body.id, itemId: form26as.id })
      .expect(404);
  });
});
