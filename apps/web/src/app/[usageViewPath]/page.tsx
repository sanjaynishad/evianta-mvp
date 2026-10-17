import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import type { UsageCasesResponse, UsageSummary } from "@evianta/core";
import { getUsageViewPath } from "@evianta/env";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer } from "@/components/shell/app-shell";
import { UsageView } from "@/components/usage/usage-view";
import { describeError } from "@/lib/api/errors";
import { createServerDataSource } from "@/lib/data/data-source";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Usage",
  robots: { index: false, follow: false, nocache: true },
};

interface UsageViewPageProps {
  params: Promise<{ usageViewPath: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}

type UsageLoadResult =
  | { ok: true; cases: UsageCasesResponse; summary: UsageSummary; fixtureMode: boolean }
  | { ok: false; error: unknown };

async function loadUsageAsync(usageViewPath: string, cursor?: string): Promise<UsageLoadResult> {
  const dataSource = createServerDataSource();
  try {
    const [cases, summary] = await Promise.all([
      dataSource.listUsageCasesAsync(usageViewPath, { cursor }),
      dataSource.getUsageSummaryAsync(usageViewPath),
    ]);
    return { ok: true, cases, summary, fixtureMode: dataSource.mode === "fixtures" };
  } catch (error) {
    return { ok: false, error };
  }
}

export default async function UsageViewPage({ params, searchParams }: UsageViewPageProps) {
  const [{ usageViewPath }, query] = await Promise.all([params, searchParams]);
  const configuredPath = getUsageViewPath();
  if (!configuredPath || decodeURIComponent(usageViewPath) !== configuredPath) {
    notFound();
  }

  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const result = await loadUsageAsync(configuredPath, cursor);
  if (!result.ok) {
    return (
      <PageContainer>
        <EmptyState
          icon={TriangleAlert}
          title="Could not load usage"
          description={describeError(result.error)}
        />
      </PageContainer>
    );
  }

  const nextPageHref = result.cases.nextCursor
    ? `?cursor=${encodeURIComponent(result.cases.nextCursor)}`
    : undefined;
  return (
    <PageContainer className="max-w-7xl">
      <UsageView
        cases={result.cases.cases}
        summary={result.summary}
        fixtureMode={result.fixtureMode}
        nextPageHref={nextPageHref}
      />
    </PageContainer>
  );
}
