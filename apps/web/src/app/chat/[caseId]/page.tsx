import type { Metadata } from "next";
import { ChatThread } from "@/components/chat/chat-thread";
import { PageContainer } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Chat",
};

interface ChatPageProps {
  params: Promise<{ caseId: string }>;
}

export default async function ChatPage({ params }: ChatPageProps) {
  const { caseId } = await params;
  return (
    <PageContainer width="reading" className="max-w-4xl pb-0 lg:pb-0">
      <ChatThread caseId={decodeURIComponent(caseId)} />
    </PageContainer>
  );
}
