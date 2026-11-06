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
        ? { title: "Payment requested — funds reserved", detail: "Reserved until the payment completes. Your ledger balance is unchanged." }
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
    case "HOLD_EXCEEDS_AVAILABLE":
      return {
        title: "Authorized above your available balance",
        detail: "The card network approved this purchase even though the hold took your available balance below zero.",
      };
    case "SUBMITTED_TO_NETWORK":
      return { title: "Sent to the ACH network", detail: "On its way to the recipient's bank. Nothing has left your ledger yet." };
    case "STATUS_CHANGED":
      return describeStatusChange(step, type);
  }
}

/** The amount a step shows: the signed ledger change for postings, the held amount for holds. */
export function stepAmount(step: TimelineStep): { cents: number; signed: boolean; note?: string } | null {
  if (step.kind === "LEDGER_POSTED") return { cents: step.ledgerDeltaCents, signed: true };
  // A flag on the authorization above it, not a second hold: no amount of its own.
  if (step.amountCents === null || step.kind === "HOLD_EXCEEDS_AVAILABLE") return null;
  const note = step.kind === "HOLD_CREATED" ? "held" : step.kind === "SETTLED_AFTER_HOLD_CLOSED" ? "was held" : "released";
  return { cents: step.amountCents, signed: false, note };
}

function describeStatusChange(step: TimelineStep, type: TransactionType): { title: string; detail: string } {
  if (type === "FUNDING") {
    if (step.toStatus === "PENDING") return { title: "Funding requested", detail: "Waiting for the payment to clear. Nothing has moved yet." };
    if (step.toStatus === "SETTLED") return { title: "Payment cleared — funding settled", detail: "The payment provider confirmed the money arrived." };
    if (step.toStatus === "FAILED") return { title: "Funding failed", detail: "The payment didn't go through, so no money moved." };
  }
  if (type === "CARD_PURCHASE") {
    if (step.toStatus === "SETTLED") {
      return { title: "Merchant settled — purchase complete", detail: "The settled amount is what left your account; it can differ from the amount authorized." };
    }
    if (step.toStatus === "REVERSED") return { title: "Authorization voided", detail: "The merchant cancelled before settling, so no money moved." };
    if (step.toStatus === "EXPIRED") return { title: "Authorization expired", detail: "The merchant never settled in time, so no money moved." };
  }
  if (type === "OUTBOUND_PAYMENT") {
    if (step.fromStatus === "PENDING" && step.toStatus === "PENDING") {
      return {
        title: "Couldn't confirm the payment was sent",
        detail: "We stopped retrying because we couldn't tell whether our bank partner received it. The amount stays reserved until we know; nothing has left your ledger.",
      };
    }
    if (step.toStatus === "PENDING") return { title: "Payment requested", detail: "Saved and waiting to be sent to our bank partner. Nothing has moved yet." };
    if (step.toStatus === "SUBMITTED") return { title: "Accepted by our bank partner", detail: "The transfer is with the bank. It completes once the recipient's bank has the money." };
    if (step.toStatus === "COMPLETED") return { title: "Payment completed", detail: "The money reached the recipient's bank." };
    if (step.toStatus === "RETURNED") return { title: "Payment returned", detail: "The recipient's bank sent it back before it settled, so no money left your account." };
    if (step.toStatus === "FAILED") {
      return { title: "Payment not sent", detail: "Our bank partner couldn't take this payment. If the amount is still reserved, we're confirming whether it went out." };
    }
  }
  if (type === "PAYMENT_RETURN" && step.toStatus === "COMPLETED") {
    return { title: "Returned payment received", detail: "The recipient's bank sent the money back after the payment had completed." };
  }
  if (type === "CARD_REVERSAL" && step.toStatus === "SETTLED") {
    return { title: "Refund received", detail: "The merchant sent money back for this purchase." };
  }
  const from = step.fromStatus ? `${statusLabel(step.fromStatus)} → ` : "";
  return { title: `Status: ${from}${statusLabel(step.toStatus)}`, detail: "" };
}
