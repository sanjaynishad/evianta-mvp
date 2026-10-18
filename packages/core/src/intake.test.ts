import { describe, expect, it } from "vitest";

import { caseSchema } from "./case.js";
import { chatMessageSchema, chatMessageText } from "./chat.js";
import {
  appendRequestMessage,
  applyIntakeChange,
  buildIntakeRequirements,
  caseIntakeSchema,
  composeRulesIntakeReply,
  createCaseIntake,
  INTAKE_MAX_REQUEST_MESSAGES,
  refreshSourceProposals,
  summarizeIntakeRequirements,
  withClarifications,
  withIntakeContext,
} from "./intake.js";

describe("withClarifications", () => {
  it("keeps only answered clarifications", () => {
    const intake = caseIntakeSchema.parse({
      clarifications: [
        { id: "period", text: "Which period?", answer: "FY 2024-25" },
        { id: "blank", text: "Anything else?", answer: "  " },
        { id: "open", text: "Buyer GSTIN?" },
      ],
    });

    expect(withClarifications(intake)).toEqual({
      clarifications: [{ question: "Which period?", answer: "FY 2024-25" }],
    });
    expect(withClarifications(undefined)).toEqual({});
  });
});

describe("appendRequestMessage", () => {
  it("trims, skips blanks, and keeps only the most recent messages", () => {
    let intake = appendRequestMessage(createCaseIntake("chat"), "   ");

    expect(intake.requestMessages).toEqual([]);

    for (let index = 0; index < INTAKE_MAX_REQUEST_MESSAGES + 2; index += 1) {
      intake = appendRequestMessage(intake, ` message ${index} `);
    }

    expect(intake.requestMessages).toHaveLength(INTAKE_MAX_REQUEST_MESSAGES);
    expect(intake.requestMessages[0]).toBe("message 2");
    expect(withIntakeContext(intake).requestMessages?.at(-1)).toBe(
      `message ${INTAKE_MAX_REQUEST_MESSAGES + 1}`,
    );
    expect(withIntakeContext(createCaseIntake("chat"))).toEqual({});
  });
});

describe("buildIntakeRequirements", () => {
  it("marks matched documents as received and the rest as missing", () => {
    const requirements = buildIntakeRequirements("tax-notice", [
      { id: "d1", name: "notice-143.pdf" },
      { id: "d2", name: "Form26AS.pdf" },
    ]);

    expect(requirements.map((entry) => [entry.item.id, entry.status])).toEqual([
      ["notice", "received"],
      ["form-26as", "received"],
      ["ledger", "missing"],
      ["computation", "missing"],
    ]);
  });

  it("prefers explicit assignments and honours skips", () => {
    const intake = caseIntakeSchema.parse({
      documentItems: { d1: "ledger" },
      skippedItemIds: ["form-26as"],
    });
    const requirements = buildIntakeRequirements(
      "tax-notice",
      [{ id: "d1", name: "scan-001.pdf" }],
      intake,
    );
    const byId = Object.fromEntries(requirements.map((entry) => [entry.item.id, entry]));

    expect(byId.ledger?.status).toBe("received");
    expect(byId.ledger?.documentIds).toEqual(["d1"]);
    expect(byId["form-26as"]?.status).toBe("skipped");
    expect(byId.notice?.status).toBe("missing");
  });

  it("summarises recommended progress", () => {
    const progress = summarizeIntakeRequirements(
      buildIntakeRequirements(
        "tax-notice",
        [{ id: "d1", name: "notice.pdf" }],
        caseIntakeSchema.parse({ skippedItemIds: ["form-26as", "ledger"] }),
      ),
    );

    expect(progress.recommendedTotal).toBe(3);
    expect(progress.recommendedReceived).toBe(1);
    expect(progress.complete).toBe(true);
  });
});

describe("composeRulesIntakeReply", () => {
  it("asks which kind of work fits when the use case is unknown", () => {
    expect(
      composeRulesIntakeReply({
        useCase: undefined,
        requirements: [],
        pendingProposals: [],
        hasDocuments: false,
      }),
    ).toMatch(/three kinds of work/);
  });

  it("lists missing recommended items and data-source proposals", () => {
    const reply = composeRulesIntakeReply({
      useCase: "msme-payment",
      requirements: buildIntakeRequirements("msme-payment", [{ id: "d1", name: "invoice-1.pdf" }]),
      pendingProposals: [{ label: "Party ledger" }],
      hasDocuments: true,
    });

    expect(reply).toContain("This looks like an MSME delayed-payment dispute.");
    expect(reply).toMatch(/purchase orders or contract/);
    expect(reply).toContain("Udyam registration certificate");
    expect(reply).toMatch(/1 item in your data sources/);
    expect(reply).not.toContain("\u2014");
  });
});

describe("applyIntakeChange", () => {
  it("records a mode switch and keeps only owned connections", () => {
    const next = applyIntakeChange(
      createCaseIntake("chat"),
      { mode: "form", enabledConnectionIds: ["conn-1", "conn-x", "conn-1"] },
      new Set(["conn-1"]),
    );

    expect(next.mode).toBe("form");
    expect(next.switchedFrom).toBe("chat");
    expect(next.enabledConnectionIds).toEqual(["conn-1"]);
  });

  it("toggles skips, assignments, and clarification answers", () => {
    const start = caseIntakeSchema.parse({
      clarifications: [{ id: "q1", text: "Which assessment year?" }],
    });
    let next = applyIntakeChange(
      start,
      { skipItem: { itemId: "ledger", skipped: true } },
      new Set(),
    );
    next = applyIntakeChange(
      next,
      { assignDocument: { documentId: "d1", itemId: "notice" } },
      new Set(),
    );
    next = applyIntakeChange(
      next,
      { answerClarification: { id: "q1", answer: "AY 2025-26" } },
      new Set(),
    );

    expect(next.skippedItemIds).toEqual(["ledger"]);
    expect(next.documentItems).toEqual({ d1: "notice" });
    expect(next.clarifications[0]?.answer).toBe("AY 2025-26");
    expect(start.skippedItemIds).toEqual([]);

    next = applyIntakeChange(next, { skipItem: { itemId: "ledger", skipped: false } }, new Set());
    next = applyIntakeChange(
      next,
      { assignDocument: { documentId: "d1", itemId: null } },
      new Set(),
    );

    expect(next.skippedItemIds).toEqual([]);
    expect(next.documentItems).toEqual({});
  });
});

describe("refreshSourceProposals", () => {
  const ledgerItem = {
    id: "party-ledger",
    connectionId: "conn-1",
    connectorId: "tally" as const,
    label: "Party ledger",
    satisfies: ["ledger", "statement"],
  };

  it("proposes enabled items for missing checklist items only", () => {
    const intake = caseIntakeSchema.parse({ enabledConnectionIds: ["conn-1"] });
    const requirements = buildIntakeRequirements("tax-notice", [{ id: "d1", name: "notice.pdf" }]);
    const next = refreshSourceProposals(intake, requirements, [
      ledgerItem,
      { ...ledgerItem, id: "notice-mail", label: "Notice email", satisfies: ["notice"] },
      { ...ledgerItem, id: "other", connectionId: "conn-2" },
    ]);

    expect(next.proposals).toHaveLength(1);
    expect(next.proposals[0]).toMatchObject({
      id: "conn-1:party-ledger",
      checklistItemId: "ledger",
      status: "proposed",
    });
    expect(refreshSourceProposals(next, requirements, [ledgerItem]).proposals).toHaveLength(1);
  });

  it("withdraws open proposals when the source is turned off but keeps attached ones", () => {
    const intake = caseIntakeSchema.parse({
      enabledConnectionIds: [],
      proposals: [
        {
          id: "conn-1:party-ledger",
          connectionId: "conn-1",
          connectorId: "tally",
          itemId: "party-ledger",
          label: "Party ledger",
          checklistItemId: "ledger",
        },
        {
          id: "conn-1:sales",
          connectionId: "conn-1",
          connectorId: "tally",
          itemId: "sales",
          label: "Sales",
          checklistItemId: "ledger",
          status: "attached",
        },
      ],
    });
    const next = refreshSourceProposals(intake, buildIntakeRequirements("tax-notice", []), []);

    expect(next.proposals.map((proposal) => proposal.id)).toEqual(["conn-1:sales"]);
  });
});

describe("intake and chat schemas", () => {
  it("defaults a new intake", () => {
    expect(createCaseIntake("chat")).toMatchObject({
      mode: "chat",
      stage: "gathering",
      supported: true,
      proposals: [],
    });
  });

  it("parses a case without a use case and with an intake", () => {
    const parsed = caseSchema.parse({
      id: "c1",
      title: "New chat",
      intake: { mode: "chat" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.useCase).toBeUndefined();
    expect(parsed.intake?.mode).toBe("chat");
  });

  it("joins the text parts of a message", () => {
    const message = chatMessageSchema.parse({
      id: "m1",
      caseId: "c1",
      role: "assistant",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        { type: "text", text: "One" },
        { type: "intake-request" },
        { type: "text", text: "Two" },
      ],
    });

    expect(chatMessageText(message)).toBe("One\n\nTwo");
  });
});
