import type { ReactNode } from "react";
import { STATUS_LABELS, type TransactionStatus } from "./labels";

const TONES: Record<TransactionStatus, string> = {
  PENDING: "bg-amber-50 text-amber-800 ring-amber-200",
  AUTHORIZED: "bg-amber-50 text-amber-800 ring-amber-200",
  SUBMITTED: "bg-amber-50 text-amber-800 ring-amber-200",
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

type EventStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "RETRY" | "FAILED" | "IGNORED";

const EVENT_TONES: Record<EventStatus, string> = {
  RECEIVED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  PROCESSING: "bg-amber-50 text-amber-800 ring-amber-200",
  RETRY: "bg-amber-50 text-amber-800 ring-amber-200",
  PROCESSED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  FAILED: "bg-red-50 text-red-800 ring-red-200",
  IGNORED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
};

/** An external event's processing status (Ops). */
export function EventStatusBadge({ status }: { status: EventStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-medium ring-1 ring-inset ${EVENT_TONES[status]}`}>
      {status}
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

type ReconciliationStatus = "MATCHED" | "AMOUNT_MISMATCH" | "STATUS_MISMATCH" | "MISSING_INTERNAL" | "MISSING_EXTERNAL" | "DUPLICATE" | "PENDING_EXTERNAL";

const RECONCILIATION_TONES: Record<ReconciliationStatus, string> = {
  MATCHED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  AMOUNT_MISMATCH: "bg-red-50 text-red-800 ring-red-200",
  STATUS_MISMATCH: "bg-red-50 text-red-800 ring-red-200",
  MISSING_INTERNAL: "bg-red-50 text-red-800 ring-red-200",
  MISSING_EXTERNAL: "bg-red-50 text-red-800 ring-red-200",
  DUPLICATE: "bg-red-50 text-red-800 ring-red-200",
  PENDING_EXTERNAL: "bg-amber-50 text-amber-800 ring-amber-200",
};

/** A reconciliation record's result (Ops). */
export function ReconciliationStatusBadge({ status }: { status: ReconciliationStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-medium ring-1 ring-inset ${RECONCILIATION_TONES[status]}`}>
      {status}
    </span>
  );
}

type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

const RUN_TONES: Record<RunStatus, string> = {
  PENDING: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  RUNNING: "bg-amber-50 text-amber-800 ring-amber-200",
  SUCCEEDED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  FAILED: "bg-red-50 text-red-800 ring-red-200",
};

/** A reconciliation run's status (Ops). */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-medium ring-1 ring-inset ${RUN_TONES[status]}`}>
      {status}
    </span>
  );
}
