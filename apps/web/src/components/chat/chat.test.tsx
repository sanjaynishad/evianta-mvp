import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { untitledChatTitle } from "@evianta/core";
import { setPendingFirstMessage, takePendingFirstMessage } from "@/lib/chat-pending";
import { createTestDataSource, renderWithDataSource } from "@/test/render-with-data";
import { ChatHome } from "./chat-home";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
});

describe("Composer", () => {
  it("sends on Enter, keeps Shift+Enter for a new line, and explains when it is read-only", () => {
    const onSubmit = vi.fn();
    const { rerender } = renderWithDataSource(
      <Composer value="Hello" onValueChange={() => {}} onSubmit={onSubmit} />,
    );
    const input = screen.getByLabelText("Message Evianta");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        value=""
        onValueChange={() => {}}
        onSubmit={onSubmit}
        disabledReason="Agents are working. Follow along above."
      />,
    );
    expect(screen.getByLabelText("Message Evianta")).toBeDisabled();
    expect(
      screen.getByPlaceholderText("Agents are working. Follow along above."),
    ).toBeInTheDocument();
  });
});

const slow = { timeout: 10000 };

describe("ChatHome", () => {
  it("fills the composer from a starting point and opens a new chat on send", async () => {
    const dataSource = createTestDataSource();
    renderWithDataSource(<ChatHome />, dataSource);

    fireEvent.click(screen.getByRole("button", { name: /Income-tax notice response/ }));
    const input = screen.getByLabelText("Message Evianta");
    expect(input).toHaveValue("Help me reply to an income-tax notice about a TDS mismatch.");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1), slow);
    const path = String(push.mock.calls[0]?.[0]);
    expect(path).toMatch(/^\/chat\//);

    const caseId = decodeURIComponent(path.replace("/chat/", ""));
    const created = await dataSource.getCaseStateAsync(caseId);
    expect(created.case).toMatchObject({ title: untitledChatTitle, intake: { mode: "chat" } });
    expect(takePendingFirstMessage(caseId)?.text).toBe(
      "Help me reply to an income-tax notice about a TDS mismatch.",
    );
  });

  it("links to guided setup and the samples", async () => {
    renderWithDataSource(<ChatHome />);

    expect(screen.getByRole("link", { name: /Prefer a form\? Use guided setup/ })).toHaveAttribute(
      "href",
      "/cases/new",
    );
    const samples = await screen.findByRole("region", { name: "Explore finished work" }, slow);
    expect(await within(samples).findAllByRole("link", { name: /^Open / }, slow)).toHaveLength(3);
  });
});

describe("ChatThread", () => {
  it("sends the first message, shows the intake checklist, and records a skipped item", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: untitledChatTitle,
      intakeMode: "chat",
    });
    setPendingFirstMessage(created.id, {
      text: "My buyer has not paid my invoices for 90 days",
      files: [],
    });

    renderWithDataSource(<ChatThread caseId={created.id} />, dataSource);

    const card = await screen.findByRole("region", { name: "To prepare this I need" }, slow);
    expect(within(card).getByText("Udyam registration certificate")).toBeInTheDocument();
    expect(screen.getByText("My buyer has not paid my invoices for 90 days")).toBeInTheDocument();
    expect(screen.getByText("Demo reply, no model call")).toBeInTheDocument();

    const udyamRow = within(card).getByText("Udyam registration certificate").closest("li");
    fireEvent.click(
      within(udyamRow as HTMLElement).getByRole("button", { name: "I don't have this" }),
    );

    await waitFor(
      () => expect(within(udyamRow as HTMLElement).getByText("Not available")).toBeInTheDocument(),
      slow,
    );
    expect(within(card).getByRole("button", { name: /Submit and start work/ })).toBeEnabled();
  });

  it("shows a finished sample with its result chips and evidence", async () => {
    const dataSource = createTestDataSource();
    const [sample] = await dataSource.listSamplesAsync();

    renderWithDataSource(<ChatThread caseId={sample?.id ?? ""} />, dataSource);

    const results = await screen.findByRole("group", { name: "Results" }, slow);
    expect(screen.getByRole("button", { name: "Try this case" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message Evianta")).not.toBeInTheDocument();

    fireEvent.click(within(results).getByRole("button", { name: /^Evidence \(\d+\)$/ }));

    const dialog = await screen.findByRole("dialog", { name: "Evidence" }, slow);
    expect(within(dialog).getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});
