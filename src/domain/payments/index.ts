/**
 * Outbound payments (ACH credits to an external recipient). An OUTBOUND_PAYMENT transaction and
 * its payment row move together:
 *
 *   PENDING ──SUBMIT──▶ SUBMITTED ──SETTLE──▶ COMPLETED
 *      │                   ├──RETURN──▶ RETURNED
 *      └──FAIL──▶ FAILED ◀─┘ (FAIL: the provider refused or rejected it)
 *
 * PENDING: saved, funds reserved by an ACTIVE PENDING_PAYMENT hold, not yet accepted by the
 * provider. SUBMITTED: the provider accepted the transfer. COMPLETED: it settled — ledger debit,
 * hold released. RETURNED: it came back before settling — hold released, no ledger entry. Money
 * returned after completion is a new PAYMENT_RETURN transaction, so the payment stays COMPLETED.
 */

export const PAYMENT_STATUSES = ["PENDING", "SUBMITTED", "COMPLETED", "RETURNED", "FAILED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentEvent = "SUBMIT" | "SETTLE" | "RETURN" | "FAIL";

/** Largest single payment: $1,000,000 (also the same-day ACH limit). */
export const MAX_PAYMENT_CENTS = 100_000_000;

const TRANSITIONS: Record<PaymentStatus, Partial<Record<PaymentEvent, PaymentStatus>>> = {
  PENDING: { SUBMIT: "SUBMITTED", FAIL: "FAILED" },
  SUBMITTED: { SETTLE: "COMPLETED", RETURN: "RETURNED", FAIL: "FAILED" },
  COMPLETED: {},
  RETURNED: {},
  FAILED: {},
};

function isPaymentStatus(status: string): status is PaymentStatus {
  return Object.hasOwn(TRANSITIONS, status);
}

/** The status `event` moves a payment in `from` to, or null if it can't move from there. */
export function nextPaymentStatus(from: string, event: PaymentEvent): PaymentStatus | null {
  return (isPaymentStatus(from) && TRANSITIONS[from][event]) || null;
}

/**
 * An ABA routing transit number: nine digits whose weighted sum 3·(d1+d4+d7) + 7·(d2+d5+d8) +
 * (d3+d6+d9) is a multiple of ten.
 */
export function isValidRoutingNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

/** The only part of a recipient account number we ever show or log. */
export function accountNumberLast4(accountNumber: string): string {
  return accountNumber.slice(-4);
}

/** What the provider's transfer, as fetched now, says has happened to it. Steps are cumulative. */
export interface TransferSnapshot {
  /** The provider sent it to the ACH network. */
  submittedToNetwork: boolean;
  /** The money reached the recipient's bank. */
  settled: boolean;
  /** The recipient's bank sent it back; `id` is the provider's id for the return. */
  returned: { id: string; reason: string | null } | null;
  /** The provider rejected or canceled it before it moved money. */
  rejected: boolean;
}

/** What we have already applied for this payment, read under the account lock. */
export interface AppliedPaymentState {
  status: PaymentStatus;
  /** The trace already has the SUBMITTED_TO_NETWORK step. */
  networkSubmissionRecorded: boolean;
  /** A PAYMENT_RETURN transaction for this transfer exists. */
  returnRecorded: boolean;
}

export type PaymentAction =
  /** PENDING → SUBMITTED: the provider has the transfer (it may have been created before we stored its id). */
  | { kind: "ACCEPT" }
  /** Trace only: the provider sent it to the network. */
  | { kind: "NETWORK_SUBMITTED" }
  /** SUBMITTED → COMPLETED: ledger debit and hold release together. */
  | { kind: "COMPLETE" }
  /** SUBMITTED → RETURNED: hold released, nothing posted. */
  | { kind: "RETURN_BEFORE_COMPLETION"; returnId: string; reason: string | null }
  /** A new PAYMENT_RETURN crediting the ledger; the payment stays COMPLETED. */
  | { kind: "RETURN_AFTER_COMPLETION"; returnId: string; reason: string | null }
  /** SUBMITTED → FAILED: the provider rejected it; hold released, nothing posted. */
  | { kind: "REJECT" };

/**
 * The steps in `snapshot` that `state` hasn't applied yet, in the order they happen. An older or
 * repeated snapshot yields nothing. `conflict` when the snapshot contradicts our records (Ops
 * decides; retrying can't change it).
 */
export function planPaymentActions(
  state: AppliedPaymentState,
  snapshot: TransferSnapshot,
): { actions: PaymentAction[] } | { conflict: string } {
  const actions: PaymentAction[] = [];
  let status = state.status;
  if (status === "FAILED") {
    return snapshot.rejected ? { actions } : { conflict: "the payment is FAILED but the provider has a live transfer for it" };
  }
  if (status === "PENDING") {
    actions.push({ kind: "ACCEPT" });
    status = "SUBMITTED";
  }
  if (snapshot.rejected) {
    if (status !== "SUBMITTED") return { conflict: `the provider rejected a transfer we have as ${status}` };
    actions.push({ kind: "REJECT" });
    return { actions };
  }
  if (status === "SUBMITTED" && snapshot.submittedToNetwork && !state.networkSubmissionRecorded) {
    actions.push({ kind: "NETWORK_SUBMITTED" });
  }
  if (status === "SUBMITTED" && snapshot.settled) {
    actions.push({ kind: "COMPLETE" });
    status = "COMPLETED";
  }
  if (snapshot.returned) {
    const { id: returnId, reason } = snapshot.returned;
    if (status === "SUBMITTED") actions.push({ kind: "RETURN_BEFORE_COMPLETION", returnId, reason });
    else if (status === "COMPLETED" && !state.returnRecorded) actions.push({ kind: "RETURN_AFTER_COMPLETION", returnId, reason });
  }
  return { actions };
}
