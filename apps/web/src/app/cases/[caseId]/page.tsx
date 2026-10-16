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
    <PageContainer className="max-w-7xl">
      <CaseWorkspace caseId={decodeURIComponent(caseId)} />
    </PageContainer>
  );
}
