import Link from "next/link";
import { Plus } from "lucide-react";
import { EmptyState } from "@/components/patterns/empty-state";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">Cases</h1>
            <p className="text-sm text-muted-foreground">
              Sample cases and the cases you create in this browser will appear here.
            </p>
          </div>
          <Button disabled>
            <Plus aria-hidden />
            New case
          </Button>
        </div>
        <EmptyState
          title="No cases yet"
          description="Case intake and the sample cases arrive with the workspace. Meanwhile, explore the visual language."
          action={
            <Button asChild variant="outline">
              <Link href="/design">Open design system</Link>
            </Button>
          }
        />
      </div>
    </PageContainer>
  );
}
