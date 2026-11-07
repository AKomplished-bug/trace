import { cn } from "@/lib/utils";
import { formatCents } from "../../lib/money";

/** An amount from integer cents with tabular figures. `signed` shows +/− and marks credits. */
export function Money({ cents, signed, className = "" }: { cents: number; signed?: boolean; className?: string }) {
  const tone = signed ? (cents > 0 ? "text-success" : cents < 0 ? "text-foreground" : "text-muted-foreground") : "";
  return <span className={cn("tabular-nums", tone, className)}>{formatCents(cents, { signed })}</span>;
}
