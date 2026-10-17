import { AiNonTransientError, createMockAi } from "@evianta/ai";
import {
  caseIntakeSchema,
  type Case,
  type CaseIntakeInput,
  type ChatMessage,
  type UseCase,
} from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  INTAKE_AGENT_KEY,
  INTAKE_SYSTEM_PROMPT,
  rulesIntakeTurn,
  runIntakeTurnAsync,
  type IntakeAgentInput,
  type IntakeDocumentSummary,
  type IntakeTurnInput,
} from "./intake.js";

const NOW = "2026-10-18T00:00:00.000Z";

function caseRecord(overrides: { useCase?: UseCase; intake?: CaseIntakeInput } = {}): Case {
  return {
    id: "case-1",
    title: "New case",
    status: "draft",
    isSample: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides.useCase ? { useCase: overrides.useCase } : {}),
    ...(overrides.intake ? { intake: caseIntakeSchema.parse(overrides.intake) } : {}),
  };
}

function userMessage(text: string, id = "m-user"): ChatMessage {
  return {
    id,
    caseId: "case-1",
    role: "user",
    createdAt: NOW,
    parts: [{ type: "text", text }],
  };
}

function turnInput(
  text: string,
  options: {
    useCase?: UseCase;
    intake?: CaseIntakeInput;
    documents?: IntakeDocumentSummary[];
    messages?: ChatMessage[];
  } = {},
): IntakeTurnInput {
  return {
    caseRecord: caseRecord(options),
    messages: options.messages ?? [userMessage(text)],
    documents: options.documents ?? [],
    pendingProposals: [],
  };
}

function modelOutput(overrides: Record<string, unknown> = {}) {
  return {
    output: {
      useCase: "tax-notice",
      switchRequested: false,
      supported: true,
      title: "Reply to 143(1) intimation for AY 2025-26",
      description: "Respond to the CPC intimation proposing a TDS adjustment.",
      reply: "This looks like an income-tax notice response. Please share the notice.",
      clarifications: [],
      ...overrides,
    },
  };
}

describe("runIntakeTurnAsync", () => {
  it("returns the model's classification, reply, and proposal", async () => {
    const ai = createMockAi({ [INTAKE_AGENT_KEY]: modelOutput() });
    const input = turnInput("I got a 143(1) intimation with a TDS mismatch", {
      documents: [{ id: "doc-1", name: "Form26AS.pdf", mimeType: "application/pdf" }],
    });

    const result = await runIntakeTurnAsync(input, { ai });

    expect(result).toMatchObject({
      useCase: "tax-notice",
      supported: true,
      title: "Reply to 143(1) intimation for AY 2025-26",
      generatedBy: "model",
      clarifications: [],
    });
    expect(result.usage.total).toBeGreaterThan(0);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.tier).toBe("cheap");
    expect(ai.calls[0]?.system).toBe(INTAKE_SYSTEM_PROMPT);

    const sent = JSON.parse(ai.calls[0]?.prompt ?? "{}") as IntakeAgentInput;

    expect(sent.currentUseCase).toBeNull();
    expect(sent.suggestedUseCase).toBe("tax-notice");
    expect(sent.catalog.map((entry) => entry.id)).toEqual([
      "data-analysis",
      "tax-notice",
      "msme-payment",
    ]);
    expect(sent.requirements.find((entry) => entry.id === "form-26as")?.status).toBe("received");
    expect(sent.requirements.find((entry) => entry.id === "notice")?.status).toBe("missing");
    expect(sent.documents).toEqual([{ name: "Form26AS.pdf", mimeType: "application/pdf" }]);
  });

  it("sends the last eight messages and labels attachment-only messages", async () => {
    const ai = createMockAi({ [INTAKE_AGENT_KEY]: modelOutput() });
    const history = Array.from({ length: 9 }, (_, index) =>
      userMessage(`message ${index}`, `m-${index}`),
    );
    const attachmentOnly: ChatMessage = {
      id: "m-files",
      caseId: "case-1",
      role: "user",
      createdAt: NOW,
      parts: [{ type: "attachments", documentIds: ["doc-1"] }],
    };

    await runIntakeTurnAsync(turnInput("", { messages: [...history, attachmentOnly] }), { ai });

    const sent = JSON.parse(ai.calls[0]?.prompt ?? "{}") as IntakeAgentInput;

    expect(sent.messages).toHaveLength(8);
    expect(sent.messages[0]?.text).toBe("message 2");
    expect(sent.messages[7]).toEqual({ role: "user", text: "(attached files)" });
  });

  it("uses the model's use case when the case has none", async () => {
    const ai = createMockAi({ [INTAKE_AGENT_KEY]: modelOutput({ useCase: "msme-payment" }) });

    const result = await runIntakeTurnAsync(turnInput("My buyer has not paid me"), { ai });

    expect(result.useCase).toBe("msme-payment");
  });

  it("keeps the case's use case unless the user explicitly asks to switch", async () => {
    const ai = createMockAi({
      [INTAKE_AGENT_KEY]: [
        modelOutput({ useCase: "data-analysis", switchRequested: false }),
        modelOutput({ useCase: "data-analysis", switchRequested: true }),
        modelOutput({ useCase: null, switchRequested: true }),
      ],
    });
    const input = turnInput("Something about sales", { useCase: "tax-notice" });

    const kept = await runIntakeTurnAsync(input, { ai });
    const switched = await runIntakeTurnAsync(input, { ai });
    const noTarget = await runIntakeTurnAsync(input, { ai });

    expect(kept.useCase).toBe("tax-notice");
    expect(switched.useCase).toBe("data-analysis");
    expect(noTarget.useCase).toBe("tax-notice");
  });

  it("clears the use case and proposal when the request is unsupported", async () => {
    const ai = createMockAi({
      [INTAKE_AGENT_KEY]: modelOutput({
        useCase: "tax-notice",
        supported: false,
        reply: "I cannot help with travel bookings. I can help with one of three kinds of work.",
      }),
    });

    const result = await runIntakeTurnAsync(
      turnInput("Book me a flight to Goa", { useCase: "tax-notice" }),
      { ai },
    );

    expect(result).toMatchObject({ useCase: undefined, supported: false, generatedBy: "model" });
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("filters document requests and duplicates, and caps clarifications at two", async () => {
    const ai = createMockAi({
      [INTAKE_AGENT_KEY]: modelOutput({
        clarifications: [
          { text: "Could you upload the notice?", kind: "text" },
          { text: "Which assessment year is this for?", kind: "text" },
          { text: "Please share a copy of the ledger.", kind: "text" },
          { text: "What is the date on the notice?", kind: "date" },
          { text: "Is this a revised return?", kind: "choice", options: ["Yes", "No"] },
          { text: "Was a rectification filed?", kind: "choice" },
        ],
      }),
    });
    const input = turnInput("143(1) intimation", {
      intake: { clarifications: [{ id: "c-1", text: "which ASSESSMENT year is this for?" }] },
    });

    const result = await runIntakeTurnAsync(input, { ai });

    expect(result.clarifications).toEqual([
      { text: "What is the date on the notice?", kind: "date" },
      { text: "Is this a revised return?", kind: "choice", options: ["Yes", "No"] },
    ]);
  });

  it("trims long titles and descriptions and removes em dashes", async () => {
    const ai = createMockAi({
      [INTAKE_AGENT_KEY]: modelOutput({
        title: "T".repeat(120),
        description: "D".repeat(500),
        reply: "This is a tax notice \u2014 I will need the notice \u2014 and Form 26AS.",
      }),
    });

    const result = await runIntakeTurnAsync(turnInput("143(1) intimation"), { ai });

    expect(result.title?.length).toBeLessThanOrEqual(80);
    expect(result.description?.length).toBeLessThanOrEqual(400);
    expect(result.reply).not.toContain("\u2014");
    expect(result.reply).toBe("This is a tax notice, I will need the notice, and Form 26AS.");
  });

  it("falls back to the rules and keeps reported usage when the model call fails", async () => {
    const ai = createMockAi({
      [INTAKE_AGENT_KEY]: {
        error: new AiNonTransientError("Response blocked", {
          reason: "blocked",
          usage: { input: 300, output: 0, total: 300 },
        }),
      },
    });

    const result = await runIntakeTurnAsync(turnInput("I received a 143(1) intimation"), { ai });

    expect(result).toMatchObject({
      useCase: "tax-notice",
      supported: true,
      generatedBy: "rules",
      usage: { input: 300, total: 300 },
    });
    expect(result.cost).toBeGreaterThan(0);
  });

  it("falls back to the rules when the model output is invalid", async () => {
    const ai = createMockAi(
      { [INTAKE_AGENT_KEY]: { output: { useCase: "poetry", reply: "" } } },
      { maxRetries: 0 },
    );

    const result = await runIntakeTurnAsync(turnInput("My buyer owes me for 60 days"), { ai });

    expect(result.generatedBy).toBe("rules");
    expect(result.useCase).toBe("msme-payment");
    expect(result.usage.total).toBeGreaterThan(0);
  });

  it("falls back to the rules on unexpected errors", async () => {
    const ai = createMockAi({ [INTAKE_AGENT_KEY]: { error: new Error("boom") } });

    const result = await runIntakeTurnAsync(turnInput("Analyse my sales trends"), { ai });

    expect(result).toMatchObject({ generatedBy: "rules", useCase: "data-analysis", cost: 0 });
  });
});

describe("rulesIntakeTurn", () => {
  it("picks the tax notice from the request text", () => {
    const result = rulesIntakeTurn(turnInput("Please help with this 143(1) intimation"));

    expect(result).toMatchObject({
      useCase: "tax-notice",
      supported: true,
      title: "Notice under section 143(1)(a)",
      clarifications: [],
      generatedBy: "rules",
      usage: { input: 0, output: 0, total: 0 },
      cost: 0,
    });
    expect(result.description).toBeTruthy();
    expect(result.reply).not.toContain("\u2014");
  });

  it("picks the tax notice from a file name", () => {
    const result = rulesIntakeTurn(
      turnInput("Here are my files", {
        documents: [{ id: "doc-1", name: "Form26AS.pdf", mimeType: "application/pdf" }],
      }),
    );

    expect(result.useCase).toBe("tax-notice");
    expect(result.reply).toContain("notice");
    expect(result.reply).not.toContain("26AS");
  });

  it("keeps the case's use case and respects skipped items", () => {
    const result = rulesIntakeTurn(
      turnInput("sales dashboard", {
        useCase: "tax-notice",
        intake: { skippedItemIds: ["notice", "form-26as", "ledger"] },
      }),
    );

    expect(result.useCase).toBe("tax-notice");
    expect(result.reply).toContain("I have everything I need");
  });

  it("offers the three kinds of work when nothing matches", () => {
    const result = rulesIntakeTurn(turnInput("hello"));

    expect(result.useCase).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.reply).toContain("three kinds of work");
  });
});

describe("INTAKE_SYSTEM_PROMPT", () => {
  it("lists every kind of work and contains no em dash", () => {
    expect(INTAKE_SYSTEM_PROMPT).toContain("tax-notice");
    expect(INTAKE_SYSTEM_PROMPT).toContain("msme-payment");
    expect(INTAKE_SYSTEM_PROMPT).toContain("data-analysis");
    expect(INTAKE_SYSTEM_PROMPT).toContain("data source");
    expect(INTAKE_SYSTEM_PROMPT).not.toContain("\u2014");
  });
});
