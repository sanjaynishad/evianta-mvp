import { Suspense } from "react";
import type { Metadata } from "next";
import { IntakeView } from "@/components/intake/intake-view";
import { PageContainer } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Guided setup",
};

export default function NewCasePage() {
  return (
    <PageContainer width="reading" className="max-w-4xl">
      {/* The form reads ?caseId= to resume a draft, which needs a Suspense boundary. */}
      <Suspense>
        <IntakeView />
      </Suspense>
    </PageContainer>
  );
}
