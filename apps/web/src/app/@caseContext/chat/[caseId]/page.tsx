import { CaseContextTitle } from "@/components/case/case-context-title";

interface ChatContextPageProps {
  params: Promise<{ caseId: string }>;
}

export default async function ChatContextPage({ params }: ChatContextPageProps) {
  const { caseId } = await params;
  return <CaseContextTitle caseId={decodeURIComponent(caseId)} />;
}
