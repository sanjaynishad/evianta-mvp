import { getUsageViewPath } from "@evianta/env";
import { CaseContextLabel } from "@/components/shell/app-shell";
import DefaultCaseContext from "../default";

interface UsageCaseContextProps {
  params: Promise<{ usageViewPath: string }>;
}

// Every single-segment path reaches this slot, so only the configured usage path is labeled.
export default async function UsageCaseContext({ params }: UsageCaseContextProps) {
  const { usageViewPath } = await params;
  const configuredPath = getUsageViewPath();
  if (!configuredPath || decodeURIComponent(usageViewPath) !== configuredPath) {
    return <DefaultCaseContext />;
  }

  return <CaseContextLabel eyebrow="Platform" title="Usage" />;
}
