import type { Metadata } from "next";
import { IntakeView } from "@/components/intake/intake-view";
import { PageContainer } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "New case",
};

export default function NewCasePage() {
  return (
    <PageContainer width="reading" className="max-w-4xl">
      <IntakeView />
    </PageContainer>
  );
}
