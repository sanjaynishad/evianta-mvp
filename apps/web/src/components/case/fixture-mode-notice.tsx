import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FixtureModeNoticeProps {
  className?: string;
}

export function FixtureModeNotice({ className }: FixtureModeNoticeProps) {
  return (
    <div
      role="note"
      data-slot="fixture-mode-notice"
      className={cn(
        "flex items-start gap-2 rounded-md border border-dashed border-info/40 bg-info-subtle px-3 py-2 text-sm text-info print:hidden",
        className,
      )}
    >
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-medium">Fixture mode.</span> No API is connected, so cases, runs, and
        results come from built-in sample data. Nothing you do here is saved after a reload.
      </p>
    </div>
  );
}
