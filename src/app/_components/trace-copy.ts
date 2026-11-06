import type { TimelineStep } from "../../services/transaction-queries";
import { STATUS_LABELS, type TransactionStatus, type TransactionType } from "./labels";

const POSTED: Record<TransactionType, string> = {
  FUNDING: "Funds received and posted to your ledger",
  CARD_PURCHASE: "Settlement posted to your ledger",
  CARD_REVERSAL: "Refund posted to your ledger",
  OUTBOUND_PAYMENT: "Payment sent and posted to your ledger",
  PAYMENT_RETURN: "Returned payment credited to your ledger",
  ADJUSTMENT: "Adjustment posted to your ledger",
};

function statusLabel(status: string | null): string {
  return status && status in STATUS_LABELS ? STATUS_LABELS[status as TransactionStatus] : (status ?? "—");
}

/** A trace step in plain words for the business owner (spec §10, §38). */
export function describeStep(step: TimelineStep, type: TransactionType): { title: string; detail: string } {
  switch (step.kind) {
    case "HOLD_CREATED":
      return type === "OUTBOUND_PAYMENT"
        ? { title: "Payment submitted — funds reserved", detail: "Reserved until the payment completes. Your ledger balance is unchanged." }
        : { title: "Card authorized — funds put on hold", detail: "The merchant reserved this amount. Nothing has moved yet, so only your available balance drops." };
    case "LEDGER_POSTED":
      return { title: POSTED[type], detail: "Money actually moved: your ledger balance changed by this amount." };
    case "HOLD_RELEASED":
      return {
        title: "Hold released",
        detail:
          type === "CARD_PURCHASE"
            ? "The reservation is lifted; only the settled amount left your account."
            : "The reserved amount no longer counts against your available balance.",
      };
    case "HOLD_EXPIRED":
      return { title: "Authorization expired — hold lifted", detail: "The merchant never settled in time, so the reserved amount is available again." };
    case "SETTLED_AFTER_HOLD_CLOSED":
      return {
        title: "Settled after the hold had already closed",
        detail: "The merchant captured late. The settlement still posted; the hold had already stopped reserving funds.",
      };
    case "STATUS_CHANGED":
      return describeStatusChange(step, type);
  }
}

/** The amount a step shows: the signed ledger change for postings, the held amount for holds. */
export function stepAmount(step: TimelineStep): { cents: number; signed: boolean; note?: string } | null {
  if (step.kind === "LEDGER_POSTED") return { cents: step.ledgerDeltaCents, signed: true };
  if (step.amountCents === null) return null;
  const note = step.kind === "HOLD_CREATED" ? "held" : step.kind === "SETTLED_AFTER_HOLD_CLOSED" ? "was held" : "released";
  return { cents: step.amountCents, signed: false, note };
}

function describeStatusChange(step: TimelineStep, type: TransactionType): { title: string; detail: string } {
  if (type === "FUNDING") {
    if (step.toStatus === "PENDING") return { title: "Funding requested", detail: "Waiting for the payment to clear. Nothing has moved yet." };
    if (step.toStatus === "SETTLED") return { title: "Payment cleared — funding settled", detail: "The payment provider confirmed the money arrived." };
    if (step.toStatus === "FAILED") return { title: "Funding failed", detail: "The payment didn't go through, so no money moved." };
  }
  const from = step.fromStatus ? `${statusLabel(step.fromStatus)} → ` : "";
  return { title: `Status: ${from}${statusLabel(step.toStatus)}`, detail: "" };
}
