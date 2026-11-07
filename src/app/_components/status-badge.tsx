import { CircleCheck, CircleDashed, CircleMinus, CircleX, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  EVENT_STATUS_LABELS,
  EVENT_STATUS_TONES,
  RECONCILIATION_STATUS_LABELS,
  RECONCILIATION_STATUS_TONES,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  type EventStatus,
  type ReconciliationStatus,
  type RunStatus,
  type Tone,
  type TransactionStatus,
} from "./labels";

const TONE_CLASSES: Record<Tone, string> = {
  // Pending is the one tone with a dashed outline, so it reads as "not final" even without colour.
  pending: "border-dashed border-pending-line bg-pending-soft text-pending",
  success: "border-success-line/60 bg-success-soft text-success",
  danger: "border-danger-line/70 bg-danger-soft text-danger",
  neutral: "border-neutral-line/70 bg-neutral-soft text-neutral-tone",
};

const TONE_ICONS: Record<Tone, LucideIcon> = {
  pending: CircleDashed,
  success: CircleCheck,
  danger: CircleX,
  neutral: CircleMinus,
};

/** A status as text with a tone and an icon; colour is never the only signal. */
export function ToneBadge({ tone, children, title, className }: { tone: Tone; children: ReactNode; title?: string; className?: string }) {
  const Icon = TONE_ICONS[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return <ToneBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</ToneBadge>;
}

/** An external event's processing status (Ops); the raw status is the tooltip. */
export function EventStatusBadge({ status }: { status: EventStatus }) {
  return (
    <ToneBadge tone={EVENT_STATUS_TONES[status]} title={status}>
      {EVENT_STATUS_LABELS[status]}
    </ToneBadge>
  );
}

/** A small tag (roles, hold states, entry kinds): text first, tone second. */
export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "emerald" }) {
  const tones = {
    neutral: "border-neutral-line/70 bg-neutral-soft text-neutral-tone",
    amber: "border-dashed border-pending-line bg-pending-soft text-pending",
    emerald: "border-success-line/60 bg-success-soft text-success",
  };
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

/** A reconciliation record's result (Ops). */
export function ReconciliationStatusBadge({ status }: { status: ReconciliationStatus }) {
  return (
    <ToneBadge tone={RECONCILIATION_STATUS_TONES[status]} title={status}>
      {RECONCILIATION_STATUS_LABELS[status]}
    </ToneBadge>
  );
}

/** A reconciliation run's status (Ops). */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <ToneBadge tone={RUN_STATUS_TONES[status]} title={status}>
      {RUN_STATUS_LABELS[status]}
    </ToneBadge>
  );
}
