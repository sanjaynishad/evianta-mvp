import type { ReactNode } from "react";
import type { CaseDocument } from "@evianta/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSourceProvider } from "@/lib/data/data-source-context";
import { createTestDataSource } from "@/test/render-with-data";
import { useCaseWorkspace } from "./use-case-workspace";

describe("useCaseWorkspace uploads", () => {
  it("keeps the newer polled document when its upload response arrives later", async () => {
    const dataSource = createTestDataSource();
    const created = await dataSource.createCaseAsync({
      title: "Upload polling",
      useCase: "data-analysis",
    });
    const first = await dataSource.uploadDocumentAsync(created.id, new File(["a,b"], "first.csv"));
    const initial = await dataSource.getCaseStateAsync(created.id);
    const uploaded: CaseDocument = {
      ...first,
      id: "second",
      name: "second.csv",
      status: "processing",
    };
    const ready: CaseDocument = { ...uploaded, status: "ready" };
    const getState = vi.spyOn(dataSource, "getCaseStateAsync");
    getState.mockResolvedValueOnce({
      ...initial,
      documents: [{ ...first, status: "processing" }],
    });
    getState.mockResolvedValue({ ...initial, documents: [first, ready] });

    let resolveUpload!: (document: CaseDocument) => void;
    vi.spyOn(dataSource, "uploadDocumentAsync").mockImplementation(
      () =>
        new Promise<CaseDocument>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const { result } = renderHook(() => useCaseWorkspace(created.id), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DataSourceProvider dataSource={dataSource}>{children}</DataSourceProvider>
      ),
    });
    await waitFor(() => expect(result.current.state?.documents).toHaveLength(1));

    let uploading!: Promise<void>;
    act(() => {
      uploading = result.current.uploadAsync([new File(["c,d"], "second.csv")]);
    });

    await waitFor(() => expect(result.current.state?.documents).toEqual([first, ready]), {
      timeout: 5000,
    });
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      resolveUpload(uploaded);
      await uploading;
    });

    expect(result.current.state?.documents).toEqual([first, ready]);
    expect(result.current.uploading).toBe(false);
  }, 10000);
});
