import { describe, expect, it } from "vitest";
import { untitledChatTitle } from "@evianta/core";
import { createTestDataSource } from "@/test/render-with-data";

describe("fixture chat data source", () => {
  it("classifies a request with the rules and retitles an untitled chat", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: untitledChatTitle,
      intakeMode: "chat",
    });
    const deltas: string[] = [];
    const reply = await dataSource.sendMessageAsync(
      created.id,
      { text: "I received a 143(1) intimation about a TDS mismatch" },
      { onDelta: (text) => deltas.push(text) },
    );

    expect(reply.case.useCase).toBe("tax-notice");
    expect(reply.case.title).toBe("Notice under section 143(1)(a)");
    expect(reply.message.generatedBy).toBe("rules");
    expect(reply.message.parts.map((part) => part.type)).toEqual(["text", "intake-request"]);
    expect(deltas.join("")).toBe(
      reply.message.parts[0]?.type === "text" ? reply.message.parts[0].text : "",
    );
    expect(await dataSource.listMessagesAsync(created.id)).toHaveLength(2);
  });

  it("offers the kinds of work when the request is unclear", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: untitledChatTitle,
      intakeMode: "chat",
    });
    const reply = await dataSource.sendMessageAsync(created.id, { text: "hello" });

    expect(reply.case.useCase).toBeUndefined();
    expect(reply.message.parts.map((part) => part.type)).toEqual(["text", "use-case-choice"]);
  });

  it("proposes and attaches data-source items with their origin", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: "Claim",
      useCase: "msme-payment",
      intakeMode: "chat",
    });
    const connection = await dataSource.connectSourceAsync("google-drive");
    const enabled = await dataSource.updateIntakeAsync(created.id, {
      enabledConnectionIds: [connection.id],
    });
    const proposal = enabled.intake?.proposals[0];

    expect(proposal).toMatchObject({ connectorId: "google-drive", checklistItemId: "udyam" });

    const attached = await dataSource.actOnSourceProposalsAsync(created.id, {
      action: "attach",
      proposalIds: [proposal?.id ?? ""],
    });

    expect(attached.documents[0]?.provenance).toMatchObject({ connectorId: "google-drive" });
    expect(attached.case.intake?.proposals[0]?.status).toBe("attached");
    expect(Object.values(attached.case.intake?.documentItems ?? {})).toEqual(["udyam"]);
  });

  it("requires a use case to run and records the run in the chat", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: untitledChatTitle,
      intakeMode: "chat",
    });

    await expect(dataSource.startRunAsync(created.id)).rejects.toMatchObject({ status: 422 });

    await dataSource.updateCaseAsync(created.id, { useCase: "data-analysis" });
    const started = await dataSource.startRunAsync(created.id);
    const messages = await dataSource.listMessagesAsync(created.id);
    const state = await dataSource.getCaseStateAsync(created.id);

    expect(messages.at(-1)?.parts[0]).toMatchObject({ type: "run", runId: started.runId });
    expect(state.case.intake?.stage).toBe("submitted");
  });

  it("refuses intake changes once the case is planned", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: "Sales",
      useCase: "data-analysis",
      intakeMode: "form",
    });

    await dataSource.startRunAsync(created.id);

    await expect(
      dataSource.updateIntakeAsync(created.id, { skipItem: { itemId: "targets", skipped: true } }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
