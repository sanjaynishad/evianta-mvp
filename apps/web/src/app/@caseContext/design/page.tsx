import { CaseContextLabel } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";

export default function DesignCaseContext() {
  return (
    <CaseContextLabel
      eyebrow="Evidence Atlas"
      title="Design system"
      meta={<Badge variant="neutral">Internal</Badge>}
    />
  );
}
