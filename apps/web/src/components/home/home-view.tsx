"use client";

import Link from "next/link";
import { Copy, FolderOpen, Plus, TriangleAlert } from "lucide-react";
import { CaseSummaryCard } from "@/components/case/case-summary-card";
import { FixtureModeNotice } from "@/components/case/fixture-mode-notice";
import { EmptyState } from "@/components/patterns/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { useTryCase } from "@/hooks/use-try-case";
import { describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";

function CardGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-44 rounded-lg" />
      ))}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="Could not load cases"
      description={describeError(error)}
      action={
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function HomeView() {
  const dataSource = useDataSource();
  const samples = useResource("samples", () => dataSource.listSamplesAsync());
  const cases = useResource("cases", () => dataSource.listCasesAsync());
  const { tryCaseAsync, copyingCaseId } = useTryCase();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Cases</h1>
          <p className="text-sm text-muted-foreground">
            Open a sample to see finished work, or start your own case.
          </p>
        </div>
        <Button asChild>
          <Link href="/cases/new">
            <Plus aria-hidden />
            New case
          </Link>
        </Button>
      </div>

      {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

      <section aria-labelledby="samples-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="samples-heading" className="text-lg font-semibold">
            Sample cases
          </h2>
          <p className="text-sm text-muted-foreground">
            Read-only examples with synthetic documents. Try one to get your own editable copy.
          </p>
        </div>
        {samples.error ? (
          <LoadError error={samples.error} onRetry={samples.reload} />
        ) : !samples.data ? (
          <CardGridSkeleton count={3} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {samples.data.map((sample) => (
              <li key={sample.id}>
                <CaseSummaryCard
                  caseItem={sample}
                  actions={
                    <>
                      <Button asChild variant="outline" size="sm">
                        <Link
                          href={`/cases/${encodeURIComponent(sample.id)}`}
                          aria-label={`Open ${sample.title}`}
                        >
                          <FolderOpen aria-hidden />
                          Open
                        </Link>
                      </Button>
                      <Button
                        size="sm"
                        loading={copyingCaseId === sample.id}
                        onClick={() => void tryCaseAsync(sample.id)}
                        aria-label={`Try ${sample.title}`}
                      >
                        {copyingCaseId === sample.id ? null : <Copy aria-hidden />}
                        Try this case
                      </Button>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="your-cases-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="your-cases-heading" className="text-lg font-semibold">
            Your cases
          </h2>
          <p className="text-sm text-muted-foreground">
            Cases created in this browser. There is no account; clearing site data removes the link
            to them.
          </p>
        </div>
        {cases.error ? (
          <LoadError error={cases.error} onRetry={cases.reload} />
        ) : !cases.data ? (
          <CardGridSkeleton count={2} />
        ) : cases.data.length === 0 ? (
          <EmptyState
            title="No cases yet"
            description="Start a new case, or try a sample to get an editable copy."
            action={
              <Button asChild variant="outline">
                <Link href="/cases/new">
                  <Plus aria-hidden />
                  New case
                </Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cases.data.map((caseItem) => (
              <li key={caseItem.id}>
                <CaseSummaryCard caseItem={caseItem} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
