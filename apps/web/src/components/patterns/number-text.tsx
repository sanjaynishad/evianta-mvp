import { formatIndianCompact, formatInr, formatInrCompact, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface NumberTextProps {
  value: number;
  compact?: boolean;
  maximumFractionDigits?: number;
  className?: string;
}

export function NumberText({
  value,
  compact = false,
  maximumFractionDigits = 2,
  className,
}: NumberTextProps) {
  const fullText = formatNumber(value, { maximumFractionDigits });
  return (
    <data
      value={String(value)}
      title={compact ? fullText : undefined}
      className={cn("figures whitespace-nowrap", className)}
    >
      {compact ? formatIndianCompact(value, maximumFractionDigits) : fullText}
    </data>
  );
}

export interface MoneyTextProps {
  amount: number;
  compact?: boolean;
  maximumFractionDigits?: number;
  className?: string;
}

export function MoneyText({
  amount,
  compact = false,
  maximumFractionDigits = 2,
  className,
}: MoneyTextProps) {
  const fullText = formatInr(amount, { maximumFractionDigits });
  return (
    <data
      value={String(amount)}
      title={compact ? fullText : undefined}
      className={cn("figures whitespace-nowrap", amount < 0 && "text-danger", className)}
    >
      {compact ? formatInrCompact(amount, maximumFractionDigits) : fullText}
    </data>
  );
}
