import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataSourceProvider } from "@/lib/data/data-source-context";
import {
  createFixtureDataSource,
  type FixtureDataSourceOptions,
} from "@/lib/data/fixture-data-source";
import type { CaseDataSource } from "@/lib/data/types";

export const testVisitorId = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

export function createTestDataSource(options: FixtureDataSourceOptions = {}): CaseDataSource {
  return createFixtureDataSource({
    replayIntervalMs: 0,
    getVisitorId: () => testVisitorId,
    now: () => new Date("2026-10-16T10:00:00.000Z"),
    ...options,
  });
}

export function renderWithDataSource(
  ui: ReactElement,
  dataSource: CaseDataSource = createTestDataSource(),
) {
  return {
    dataSource,
    ...render(
      <DataSourceProvider dataSource={dataSource}>
        <TooltipProvider>{ui}</TooltipProvider>
      </DataSourceProvider>,
    ),
  };
}

// recharts sizes charts with ResizeObserver, which jsdom does not provide.
export function stubResizeObserver(): void {
  if (typeof globalThis.ResizeObserver === "function") {
    return;
  }

  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
