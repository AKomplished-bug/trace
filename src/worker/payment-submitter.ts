import { and, eq, sql } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { accounts, payments } from "../db/schema";
import { IdempotencyKeyReusedError, ProviderRejectedError } from "../integrations/payment-provider";
import type { TransferProvider } from "../integrations/transfer-provider";
import { safeErrorForLog, safeErrorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { lockAccount } from "../services/accounts";
import { countOutcome } from "../services/metrics";
import {
  DEFAULT_STATEMENT_DESCRIPTOR,
  failPayment,
  lockPayment,
  markPaymentSubmissionGivenUp,
  markPaymentSubmitted,
  paymentIdempotencyKey,
  type Payment,
} from "../services/payments";
import { backoffMs } from "./events";

/**
 * The outbound payment submitter: the outbox side of POST /payments. A PENDING payment is the
 * persisted intent; this claims one due payment at a time, calls the provider after the claim has
 * committed (no transaction or lock held across the call) with the idempotency key
 * `payment-<id>`, and records the outcome conditionally on the claim. A crash anywhere just means
 * the lease expires and the next claim repeats the call with the same key, which returns the
 * transfer created the first time.
 */

/** Same budget and backoff as events: 5 s doubling, capped at 15 min; about 36 minutes before giving up. */
export const MAX_SUBMIT_ATTEMPTS = 10;
const MAX_ERROR_LENGTH = 1_000;
/** Increase refusals that don't show the transfer wasn't created: auth, permissions, conflicts. Retried within the budget. */
const UNKNOWN_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 403, 409]);

export interface ClaimedPayment {
  id: string;
  accountId: string;
  transactionId: string;
  /** Claims so far, including this one; the retry budget. */
  attempts: number;
  /** Fencing token of this claim; every later write requires it to still match. */
  claimToken: number;
}

/**
 * Atomically claims the oldest due PENDING payment: bumps submit_attempts and submit_claim_token
 * and pushes next_submit_at out by the lease, so a worker that dies leaves it claimable again once
 * the lease expires. One autocommitted statement that waits on no other lock (SKIP LOCKED), so it
 * can't deadlock with writers that take account → payment.
 */
export async function claimNextPayment(db: Db, { leaseSeconds }: { leaseSeconds: number }): Promise<ClaimedPayment | null> {
  const { rows } = await db.execute<{ id: string; account_id: string; transaction_id: string; submit_attempts: number; submit_claim_token: number }>(sql`
    UPDATE ${payments}
    SET submit_attempts = submit_attempts + 1,
        submit_claim_token = submit_claim_token + 1,
        next_submit_at = now() + make_interval(secs => ${leaseSeconds})
    WHERE id = (
      SELECT id FROM ${payments}
      WHERE status = 'PENDING' AND submit_gave_up_at IS NULL AND next_submit_at <= now()
      ORDER BY next_submit_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, account_id, transaction_id, submit_attempts, submit_claim_token
  `);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, accountId: row.account_id, transactionId: row.transaction_id, attempts: row.submit_attempts, claimToken: row.submit_claim_token };
}

export type SubmitOutcome =
  | "submitted"
  /** The provider refused the first attempt: FAILED, hold released. */
  | "rejected"
  /** Stopped retrying with the outcome at the provider unknown: still PENDING with its hold, for Ops. */
  | "gave_up"
  | "retry"
  | "lease_lost";

/** `payment_submissions_total{outcome}`. */
function countSubmission(outcome: Exclude<SubmitOutcome, "rejected"> | "rejected_first_attempt"): void {
  countOutcome("payment_submissions_total", { outcome });
}

/** Our claim on the payment, unchanged since we took it. */
function claimed(payment: ClaimedPayment) {
  return and(eq(payments.id, payment.id), eq(payments.status, "PENDING"), eq(payments.submitClaimToken, payment.claimToken));
}

/** Submits one claimed payment and records the outcome. Never throws for provider failures. */
export async function submitPayment(db: Db, claim: ClaimedPayment, provider: TransferProvider, logger: Logger): Promise<SubmitOutcome> {
  const log = logger.child({ payment_id: claim.id, transaction_id: claim.transactionId, account_id: claim.accountId, attempt: claim.attempts, provider: provider.name });
  const [intent] = await db
    .select({ payment: payments, sourceAccountId: accounts.providerId, queueAgeSeconds: sql<number>`extract(epoch from now() - ${payments.createdAt})`.mapWith(Number) })
    .from(payments)
    .innerJoin(accounts, eq(accounts.id, payments.accountId))
    .where(claimed(claim));
  if (!intent) {
    log.warn({ outcome: "lease_lost" }, "payment claim lost or payment moved on; skipped");
    countSubmission("lease_lost");
    return "lease_lost";
  }
  const { payment, sourceAccountId } = intent;
  const queueAgeSeconds = Math.round(intent.queueAgeSeconds);

  // Claimed more than the budget means earlier attempts never finished (crash or lease expiry).
  if (claim.attempts > MAX_SUBMIT_ATTEMPTS) {
    return giveUp(db, claim, log, `gave up after ${MAX_SUBMIT_ATTEMPTS} attempts; the last ones did not finish (worker crash or lease expiry)`);
  }
  if (!sourceAccountId) {
    const message = `account ${claim.accountId} is not linked to a provider account`;
    // Nothing can be sent without a source account; an earlier attempt might have been, though.
    return claim.attempts === 1 ? reject(db, claim, log, message) : giveUp(db, claim, log, message);
  }

  log.info({ outcome: "attempting", queue_age_seconds: queueAgeSeconds }, "submitting payment to provider");
  try {
    const transfer = await provider.createTransfer({
      sourceAccountId,
      amountCents: payment.amountCents,
      accountNumber: payment.accountNumber,
      routingNumber: payment.routingNumber,
      recipientName: payment.recipient,
      statementDescriptor: payment.description ?? DEFAULT_STATEMENT_DESCRIPTOR,
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });
    const txLog = log.child({ provider_object_id: transfer.id, provider_request_id: transfer.requestId, provider_status: transfer.status });
    const recorded = await withTransaction(db, async (tx) => {
      await lockAccount(tx, claim.accountId);
      const current = await lockPayment(tx, claim.id);
      if (current.status === "PENDING" && current.submitClaimToken === claim.claimToken) {
        await markPaymentSubmitted(tx, current, transfer.id, {});
        return "submitted" as const;
      }
      // The webhook may have linked the same transfer first (it finds the payment by our key).
      return current.providerObjectId === transfer.id ? ("already_linked" as const) : ("lease_lost" as const);
    });
    if (recorded === "lease_lost") {
      txLog.warn({ outcome: "lease_lost" }, "transfer created but the claim was lost; the current owner records it with the same key");
      countSubmission("lease_lost");
      return "lease_lost";
    }
    countSubmission("submitted");
    txLog.info({ outcome: recorded, queue_age_seconds: queueAgeSeconds }, "payment accepted by provider");
    return "submitted";
  } catch (error) {
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    const errLog = log.child({ provider_request_id: requestId });
    if (error instanceof IdempotencyKeyReusedError) {
      // A transfer exists for our key with different arguments: money may move. Never release.
      return giveUp(db, claim, errLog.child({ provider_object_id: error.resourceId }), safeErrorMessage(error), error);
    }
    // 401/403/409 are our credentials, permissions or a conflict, never proof either way and
    // possibly passing (a rotated key, a lock at Increase): retried like a timeout, hold kept.
    if (error instanceof ProviderRejectedError && !UNKNOWN_REJECTION_STATUSES.has(error.status ?? 0)) {
      // Only a refusal of the very first attempt proves nothing was sent: after a timeout, Increase
      // may already have created the transfer.
      return claim.attempts === 1 ? reject(db, claim, errLog, safeErrorMessage(error), error) : giveUp(db, claim, errLog, safeErrorMessage(error), error);
    }
    if (claim.attempts >= MAX_SUBMIT_ATTEMPTS) return giveUp(db, claim, errLog, safeErrorMessage(error), error);
    return retry(db, claim, errLog, safeErrorMessage(error), error);
  }
}

/** Timeouts, 5xx, rate limits, 401/403/409, our own failures after the call: try again later with the same key. */
async function retry(db: Db, claim: ClaimedPayment, log: Logger, message: string, error: unknown): Promise<SubmitOutcome> {
  const delaySeconds = backoffMs(claim.attempts) / 1000;
  const updated = await db
    .update(payments)
    .set({ nextSubmitAt: sql`now() + make_interval(secs => ${delaySeconds})`, lastSubmitError: message.slice(0, MAX_ERROR_LENGTH) })
    .where(claimed(claim))
    .returning({ id: payments.id });
  if (!updated.length) {
    log.warn({ outcome: "lease_lost", err: safeErrorForLog(error) }, "payment submission failed after its claim was lost");
    countSubmission("lease_lost");
    return "lease_lost";
  }
  countSubmission("retry");
  log.warn({ outcome: "retry", err: safeErrorForLog(error), retry_in_seconds: delaySeconds }, "payment submission failed; will retry with the same idempotency key");
  return "retry";
}

/** The provider refused the first attempt, so nothing was sent: FAILED and the hold released. */
async function reject(db: Db, claim: ClaimedPayment, log: Logger, message: string, error?: unknown): Promise<SubmitOutcome> {
  const done = await withTransaction(db, async (tx): Promise<Payment | null> => {
    await lockAccount(tx, claim.accountId);
    const current = await lockPayment(tx, claim.id);
    if (current.status !== "PENDING" || current.submitClaimToken !== claim.claimToken) return null;
    return failPayment(tx, current, { error: message.slice(0, MAX_ERROR_LENGTH) });
  });
  const err = error === undefined ? undefined : safeErrorForLog(error);
  if (!done) {
    log.warn({ outcome: "lease_lost", err, error_message: message }, "payment failed after its claim was lost; left to the new owner");
    countSubmission("lease_lost");
    return "lease_lost";
  }
  countSubmission("rejected_first_attempt");
  log.error({ outcome: "rejected", err, error_message: message }, "provider refused the payment; FAILED and hold released");
  return "rejected";
}

/**
 * The outcome at the provider is unknown (an earlier attempt may have created the transfer, or a
 * transfer exists for our key): stop resubmitting, keep the payment PENDING with its hold, and
 * record it. A later webhook for the transfer (found by our key) moves it on as usual; until then
 * Ops sees it in the backlog log line and on the trace.
 */
async function giveUp(db: Db, claim: ClaimedPayment, log: Logger, message: string, error?: unknown): Promise<SubmitOutcome> {
  const done = await withTransaction(db, async (tx): Promise<boolean> => {
    await lockAccount(tx, claim.accountId);
    const current = await lockPayment(tx, claim.id);
    if (current.status !== "PENDING" || current.submitClaimToken !== claim.claimToken) return false;
    await markPaymentSubmissionGivenUp(tx, current, message.slice(0, MAX_ERROR_LENGTH));
    return true;
  });
  const err = error === undefined ? undefined : safeErrorForLog(error);
  if (!done) {
    log.warn({ outcome: "lease_lost", err, error_message: message }, "payment submission gave up after its claim was lost; left to the new owner");
    countSubmission("lease_lost");
    return "lease_lost";
  }
  countSubmission("gave_up");
  log.error({ outcome: "gave_up", err, error_message: message }, "payment submission gave up with the outcome unknown; PENDING with its hold, for Ops");
  return "gave_up";
}
