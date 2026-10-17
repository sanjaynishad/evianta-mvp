import { CaseContextTitle } from "@/components/case/case-context-title";

interface CaseContextPageProps {
  params: Promise<{ caseId: string }>;
}

export default async function CaseContextPage({ params }: CaseContextPageProps) {
  const { caseId } = await params;
  return <CaseContextTitle caseId={decodeURIComponent(caseId)} />;
}
