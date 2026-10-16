import { Copy, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface SampleBannerProps {
  onTryCase: () => void;
  copying?: boolean;
}

export function SampleBanner({ onTryCase, copying = false }: SampleBannerProps) {
  return (
    <div
      role="region"
      aria-label="Read-only sample"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info-subtle px-4 py-3 print:hidden"
    >
      <Lock aria-hidden className="size-4 shrink-0 text-info" />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        <span className="font-medium">This is a read-only sample.</span> Try this case to upload
        documents, run it, and edit the results in your own copy.
      </p>
      <Button size="sm" onClick={onTryCase} loading={copying}>
        {copying ? null : <Copy aria-hidden />}
        Try this case
      </Button>
    </div>
  );
}
