import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { payments } from "../db/schema";
import type { TransferProvider } from "../integrations/transfer-provider";
import { safeErrorForLog } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { lockAccount } from "./accounts";
import { recordAudit } from "./audit";
import { countOutcome } from "./metrics";
import { failPayment, lockPayment, paymentIdempotencyKey, type Payment } from "./payments";

/**
 * Ops actions on payments the submitter gave up on (PENDING, `submit_gave_up_at` set, hold
 * ACTIVE): requeue them, or, once Increase confirms it has no transfer under our key, fail them
 * and release the hold. Both are conditional on that state, audited and counted.
 */

export const PAYMENT_AUDIT_ENTITY = "payment";
export const PAYMENT_REQUEUE_ACTION = "payment.requeue";
export const PAYMENT_CONFIRM_NOT_SENT_ACTION = "payment.confirm_not_sent";
/**
 * Confirm-not-sent waits this long after the give-up, so a create Increase is still processing (or
 * a list that hasn't caught up) can't read as "no transfer".
 */
export const CONFIRM_NOT_SENT_MIN_AGE_SECONDS = 5 * 60;
/** The given-up list shows at most this many, oldest first. */
const GIVEN_UP_LIST_LIMIT = 50;

type PaymentStatus = Payment["status"];

// Whether a give-up is old enough to confirm, by the database clock (the one that set it).
const oldEnoughToConfirm = sql<boolean>`${payments.submitGaveUpAt} <= now() - make_interval(secs => ${CONFIRM_NOT_SENT_MIN_AGE_SECONDS})`;

const givenUp = (payment: Pick<Payment, "status" | "submitGaveUpAt">) => payment.status === "PENDING" && payment.submitGaveUpAt !== null;

/** `ops_payment_actions_total{action,outcome}`. */
function countAction(action: "requeue" | "confirm_not_sent", outcome: string): void {
  countOutcome("ops_payment_actions_total", { action, outcome });
}

/** Given-up payments, oldest give-up first. */
export async function listGivenUpPayments(db: Db) {
  return db
    .select({
      id: payments.id,
      transactionId: payments.transactionId,
      accountId: payments.accountId,
      recipient: payments.recipient,
      amountCents: payments.amountCents,
      submitAttempts: payments.submitAttempts,
      /** Sanitized when stored. */
      lastSubmitError: payments.lastSubmitError,
      submitGaveUpAt: payments.submitGaveUpAt,
      confirmable: oldEnoughToConfirm,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.status, "PENDING"), isNotNull(payments.submitGaveUpAt)))
    .orderBy(asc(payments.submitGaveUpAt), asc(payments.id))
    .limit(GIVEN_UP_LIST_LIMIT);
}

export interface PaymentActionInput {
  paymentId: string;
  userId: string;
  correlationId: string;
}

export type RequeueResult =
  | { outcome: "requeued"; payment: { id: string; status: PaymentStatus; submitAttempts: number; nextSubmitAt: Date } }
  | { outcome: "not_found" }
  | { outcome: "not_given_up"; status: PaymentStatus };

/**
 * Hands a given-up payment back to the submitter: `submit_gave_up_at` cleared, attempts reset (a
 * fresh budget), due now, plus its audit row, in one transaction under account → payment locks.
 * Safe whatever happened at Increase: the submitter resends with the same `payment-<id>` key, so
 * a transfer created earlier is returned, not duplicated. A second click finds it no longer given
 * up: not_given_up.
 */
export async function requeuePayment(db: Db, input: PaymentActionInput): Promise<RequeueResult> {
  const result = await withTransaction(db, async (tx): Promise<RequeueResult> => {
    const [found] = await tx.select({ accountId: payments.accountId }).from(payments).where(eq(payments.id, input.paymentId));
    if (!found) return { outcome: "not_found" };
    await lockAccount(tx, found.accountId);
    const before = await lockPayment(tx, input.paymentId);
    if (!givenUp(before)) return { outcome: "not_given_up", status: before.status };
    const [after] = await tx
      .update(payments)
      .set({ submitGaveUpAt: null, submitAttempts: 0, nextSubmitAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(payments.id, before.id), eq(payments.status, "PENDING"), isNotNull(payments.submitGaveUpAt)))
      .returning({ id: payments.id, status: payments.status, submitAttempts: payments.submitAttempts, nextSubmitAt: payments.nextSubmitAt });
    // Unreachable while we hold the row lock; a zero-row update must still never pass as a requeue.
    if (!after) throw new Error(`payment ${before.id} stopped being given up while locked`);
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: PAYMENT_REQUEUE_ACTION,
      entityType: PAYMENT_AUDIT_ENTITY,
      entityId: before.id,
      previousState: { status: before.status, submitAttempts: before.submitAttempts, givenUp: true },
      newState: { status: after.status, submitAttempts: after.submitAttempts, givenUp: false },
      correlationId: input.correlationId,
    });
    return { outcome: "requeued", payment: after };
  });
  countAction("requeue", result.outcome);
  return result;
}

export type ConfirmNotSentResult =
  | { outcome: "failed"; payment: { id: string; status: PaymentStatus } }
  | { outcome: "not_found" }
  | { outcome: "not_given_up"; status: PaymentStatus }
  /** Given up less than CONFIRM_NOT_SENT_MIN_AGE_SECONDS ago. Nothing changed, Increase not asked. */
  | { outcome: "too_soon" }
  /** Increase has a transfer under our key (or we stored one): money may have left. Nothing changed. */
  | { outcome: "transfer_exists"; transferId: string }
  /** Increase couldn't be asked (timeout, 5xx, refusal). Nothing changed. */
  | { outcome: "provider_error" }
  /** The payment moved (requeued, claimed, given up again, accepted) after Increase was asked. Nothing changed. */
  | { outcome: "changed"; status: PaymentStatus };

/**
 * Ops confirms a given-up payment never went out: FAILED with the hold released (`failPayment`:
 * HOLD_RELEASED, then STATUS_CHANGED → FAILED), plus its audit row. Only once the give-up is
 * CONFIRM_NOT_SENT_MIN_AGE_SECONDS old; then, with no transaction open, it asks Increase for a
 * transfer under our `payment-<id>` key (the adapter's 10 s timeout); a transfer, or no answer,
 * refuses and changes nothing. The transaction then re-checks that the
 * payment is still given up under the same claim token, so a requeue or a submission between the
 * check and the write can't be failed on a stale answer.
 */
export async function confirmPaymentNotSent(db: Db, provider: TransferProvider, input: PaymentActionInput, logger: Logger): Promise<ConfirmNotSentResult> {
  const result = await confirmNotSent(db, provider, input, logger.child({ payment_id: input.paymentId, provider: provider.name }));
  countAction("confirm_not_sent", result.outcome);
  return result;
}

async function confirmNotSent(db: Db, provider: TransferProvider, input: PaymentActionInput, log: Logger): Promise<ConfirmNotSentResult> {
  const [row] = await db.select({ payment: payments, oldEnough: oldEnoughToConfirm }).from(payments).where(eq(payments.id, input.paymentId));
  if (!row) return { outcome: "not_found" };
  const seen = row.payment;
  if (!givenUp(seen)) return { outcome: "not_given_up", status: seen.status };
  if (!row.oldEnough) return { outcome: "too_soon" };
  if (seen.providerObjectId) return { outcome: "transfer_exists", transferId: seen.providerObjectId };
  const checkLog = log.child({ account_id: seen.accountId, transaction_id: seen.transactionId });

  let transfer;
  try {
    transfer = await provider.findTransferByIdempotencyKey(paymentIdempotencyKey(seen.id));
  } catch (error) {
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    checkLog.warn({ outcome: "provider_error", provider_request_id: requestId, err: safeErrorForLog(error) }, "couldn't ask the provider whether the payment was sent; nothing changed");
    return { outcome: "provider_error" };
  }
  if (transfer) {
    checkLog.warn(
      { outcome: "transfer_exists", provider_object_id: transfer.id, provider_request_id: transfer.requestId, provider_status: transfer.status },
      "provider has a transfer under our key; not failing the payment",
    );
    return { outcome: "transfer_exists", transferId: transfer.id };
  }

  return withTransaction(db, async (tx): Promise<ConfirmNotSentResult> => {
    await lockAccount(tx, seen.accountId);
    const current = await lockPayment(tx, seen.id);
    if (!givenUp(current) || current.submitClaimToken !== seen.submitClaimToken) return { outcome: "changed", status: current.status };
    const failed = await failPayment(tx, current, {});
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: PAYMENT_CONFIRM_NOT_SENT_ACTION,
      entityType: PAYMENT_AUDIT_ENTITY,
      entityId: current.id,
      previousState: { status: current.status, holdStatus: "ACTIVE", givenUp: true },
      newState: { status: failed.status, holdStatus: "RELEASED" },
      correlationId: input.correlationId,
    });
    checkLog.info({ outcome: "failed", from_status: current.status, to_status: failed.status }, "provider has no transfer under our key; payment failed and hold released by Ops");
    return { outcome: "failed", payment: { id: failed.id, status: failed.status } };
  });
}
