import { webApiBaseUrl } from "@evianta/env/public";

export type DataSourceMode = "live" | "fixtures";

export const apiBaseUrl = webApiBaseUrl;

export const dataSourceMode: DataSourceMode = apiBaseUrl ? "live" : "fixtures";
