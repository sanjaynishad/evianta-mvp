import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/app-shell";
import { DesignGallery } from "./design-gallery";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

export default function DesignPage() {
  return (
    <PageContainer>
      <DesignGallery />
    </PageContainer>
  );
}
