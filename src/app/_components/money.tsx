import { formatCents } from "../../lib/money";

/** An amount from integer cents, monospace with tabular figures. `signed` shows +/−. */
export function Money({ cents, signed, className = "" }: { cents: number; signed?: boolean; className?: string }) {
  const tone = signed ? (cents > 0 ? "text-emerald-700" : cents < 0 ? "text-neutral-900" : "text-neutral-500") : "";
  return <span className={`font-mono tabular-nums ${tone} ${className}`}>{formatCents(cents, { signed })}</span>;
}
