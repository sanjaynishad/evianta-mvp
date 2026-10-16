"use client";

import { createContext, useContext, type ReactNode } from "react";
import { getDataSource } from "./data-source";
import type { CaseDataSource } from "./types";

const DataSourceContext = createContext<CaseDataSource | null>(null);

export interface DataSourceProviderProps {
  dataSource: CaseDataSource;
  children: ReactNode;
}

export function DataSourceProvider({ dataSource, children }: DataSourceProviderProps) {
  return <DataSourceContext.Provider value={dataSource}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): CaseDataSource {
  return useContext(DataSourceContext) ?? getDataSource();
}
