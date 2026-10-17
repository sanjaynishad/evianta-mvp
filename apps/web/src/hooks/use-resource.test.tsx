import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResource } from "./use-resource";

interface Deferred {
  resolve: (value: string) => void;
}

function controlledLoads() {
  const pending: Deferred[] = [];
  const loadAsync = () =>
    new Promise<string>((resolve) => {
      pending.push({ resolve });
    });
  return { pending, loadAsync };
}

describe("useResource", () => {
  it("discards a load that was in flight when the data was mutated, then loads again", async () => {
    const { pending, loadAsync } = controlledLoads();
    const { result } = renderHook(() => useResource("case", loadAsync));

    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.resolve("first"));
    expect(result.current.data).toBe("first");

    act(() => result.current.reload());
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => result.current.mutate(() => "local change"));
    await act(async () => pending[1]!.resolve("stale snapshot"));

    expect(result.current.data).toBe("local change");
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2]!.resolve("fresh snapshot"));
    expect(result.current.data).toBe("fresh snapshot");
    expect(result.current.loading).toBe(false);
  });

  it("applies a load that finished before the mutation, then keeps the mutation", async () => {
    const { pending, loadAsync } = controlledLoads();
    const { result } = renderHook(() => useResource("case", loadAsync));

    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.resolve("first"));
    act(() => result.current.reload());
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!.resolve("reloaded"));
    expect(result.current.data).toBe("reloaded");

    act(() => result.current.mutate((current) => `${current} and changed`));

    expect(result.current.data).toBe("reloaded and changed");
    expect(result.current.loading).toBe(false);
    expect(pending).toHaveLength(2);
  });
});
