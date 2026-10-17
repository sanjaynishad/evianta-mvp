import type { Metadata } from "next";
import { CaseWorkspace } from "@/components/case/case-workspace";
import { PageContainer } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Case workspace",
};

interface CasePageProps {
  params: Promise<{ caseId: string }>;
}

export default async function CasePage({ params }: CasePageProps) {
  const { caseId } = await params;
  return (
    <PageContainer width="full" className="px-4 py-4 sm:px-6 lg:py-4">
      <CaseWorkspace caseId={decodeURIComponent(caseId)} />
    </PageContainer>
  );
}
