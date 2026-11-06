import type { ReactNode } from "react";
import { STATUS_LABELS, type TransactionStatus } from "./labels";

const TONES: Record<TransactionStatus, string> = {
  PENDING: "bg-amber-50 text-amber-800 ring-amber-200",
  AUTHORIZED: "bg-amber-50 text-amber-800 ring-amber-200",
  SETTLED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  COMPLETED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  REVERSED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  RETURNED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  EXPIRED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  FAILED: "bg-red-50 text-red-800 ring-red-200",
};

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** A small neutral tag (roles, hold states, entry kinds). */
export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "emerald" }) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-700 ring-neutral-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}
