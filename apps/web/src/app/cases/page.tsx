import type { Metadata } from "next";
import { HomeView } from "@/components/home/home-view";
import { PageContainer } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Cases",
};

export default function CasesPage() {
  return (
    <PageContainer>
      <HomeView />
    </PageContainer>
  );
}
