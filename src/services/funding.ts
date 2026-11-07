import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/client";
import { externalEvents, transactions } from "../db/schema";
import { fundingOutcomeStatus, nextFundingStatus, type FundingEvent } from "../domain/funding";
import { ENTRY_TYPE_FOR_TRANSACTION } from "../domain/ledger";
import type { PaymentProvider, ProviderPayment } from "../integrations/payment-provider";
import { PermanentEventError, safeErrorForLog, safeErrorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { lockAccount } from "./accounts";
import { postLedgerEntry } from "./ledger";
import { countOutcome } from "./metrics";
import { appendTraceEvent } from "./trace";

export type Transaction = typeof transactions.$inferSelect;

/** The Idempotency-Key was already used for a different request on this account. */
export class IdempotencyConflictError extends Error {
  constructor(readonly transactionId: string) {
    super(`Idempotency-Key already used for a different request (transaction ${transactionId})`);
    this.name = "IdempotencyConflictError";
  }
}

/** The funding is saved as PENDING but the provider call failed or timed out; retrying with the same key is safe. */
export class FundingProviderError extends Error {
  constructor(
    readonly transactionId: string,
    reason: string,
  ) {
    super(`Provider call for funding ${transactionId} failed: ${reason}`);
    this.name = "FundingProviderError";
  }
}

/** The payment names one of our transactions in its metadata, but that FUNDING transaction isn't there (yet). Retryable. */
export class FundingNotFoundError extends Error {
  constructor(provider: string, paymentId: string, transactionId: string) {
    super(`No FUNDING transaction ${transactionId} for ${provider} payment ${paymentId}`);
    this.name = "FundingNotFoundError";
  }
}

/** The payment carries none of our metadata, so no account of ours asked for it. Permanent. */
export class FundingNotOursError extends PermanentEventError {
  constructor(provider: string, paymentId: string) {
    super(`${provider} payment ${paymentId} has no Trace transaction_id metadata and matches no FUNDING transaction`);
    this.name = "FundingNotOursError";
  }
}

/** The provider's payment contradicts our transaction (amount, currency, or a different payment id). Permanent: Ops decides. */
export class FundingOutcomeMismatchError extends PermanentEventError {
  constructor(message: string) {
    super(message);
    this.name = "FundingOutcomeMismatchError";
  }
}

/** The provider's payment status doesn't (yet) match the event, e.g. still processing. Retryable. */
export class FundingStatusMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingStatusMismatchError";
  }
}

/** Hash of the command body, stored with the idempotency key; includes the type so a key can't be reused across commands. */
export function requestHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** The idempotency key we send the provider: one per transaction, so retries never create a second payment. */
export function providerIdempotencyKey(transactionId: string): string {
  return `funding-${transactionId}`;
}

export interface CreateFundingInput {
  accountId: string;
  amountCents: number;
  idempotencyKey: string;
}

/**
 * POST /funding. One DB transaction creates the PENDING FUNDING transaction and its first trace
 * row; the same key with the same body returns that transaction instead, a different body throws
 * `IdempotencyConflictError`. After commit (no network call inside the transaction) the provider
 * payment is created and its id stored. If that call fails the transaction stays PENDING and
 * `FundingProviderError` is thrown: the outcome at the provider may be unknown, and retrying with
 * the same Idempotency-Key repeats the call with the same provider idempotency key.
 */
export async function createFunding(
  db: Db,
  provider: PaymentProvider,
  input: CreateFundingInput,
  logger: Logger,
): Promise<{ transaction: Transaction; replayed: boolean }> {
  const hash = requestHash({ type: "FUNDING", amountCents: input.amountCents });
  const { transaction, replayed } = await withTransaction(db, async (tx) => {
    await lockAccount(tx, input.accountId);
    const [inserted] = await tx
      .insert(transactions)
      .values({
        accountId: input.accountId,
        type: "FUNDING",
        status: "PENDING",
        amountCents: input.amountCents,
        provider: provider.name,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .onConflictDoNothing({ target: [transactions.accountId, transactions.idempotencyKey] })
      .returning();
    if (inserted) {
      await appendTraceEvent(tx, {
        accountId: input.accountId,
        transactionId: inserted.id,
        kind: "STATUS_CHANGED",
        amountCents: inserted.amountCents,
        toStatus: "PENDING",
      });
      return { transaction: inserted, replayed: false };
    }
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, input.accountId), eq(transactions.idempotencyKey, input.idempotencyKey)));
    if (existing.requestHash !== hash) throw new IdempotencyConflictError(existing.id);
    return { transaction: existing, replayed: true };
  });

  const log = logger.child({ account_id: transaction.accountId, transaction_id: transaction.id, provider: provider.name });
  log.info({ outcome: replayed ? "replayed" : "created", amount_cents: transaction.amountCents }, "funding transaction ready");
  if (transaction.providerObjectId) {
    countOutcome("funding_requests_total", { outcome: "replayed" });
    return { transaction, replayed };
  }

  let payment: ProviderPayment;
  try {
    payment = await provider.createFundingPayment({
      amountCents: transaction.amountCents,
      idempotencyKey: providerIdempotencyKey(transaction.id),
      metadata: { transaction_id: transaction.id, account_id: transaction.accountId },
    });
  } catch (error) {
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    countOutcome("funding_requests_total", { outcome: "provider_error" });
    log.error({ outcome: "provider_error", err: safeErrorForLog(error), provider_request_id: requestId }, "funding provider call failed; transaction stays PENDING");
    throw new FundingProviderError(transaction.id, safeErrorMessage(error));
  }
  countOutcome("funding_requests_total", { outcome: payment.status === "FAILED" ? "provider_declined" : "provider_created" });
  log.info(
    {
      outcome: payment.status === "FAILED" ? "provider_declined" : "provider_created",
      provider_object_id: payment.id,
      provider_status: payment.status,
      provider_request_id: payment.requestId,
    },
    "funding payment created at provider",
  );

  // Only the first writer sets the id; a concurrent retry with the same key got the same payment.
  await db
    .update(transactions)
    .set({ providerObjectId: payment.id, updatedAt: sql`now()` })
    .where(and(eq(transactions.id, transaction.id), isNull(transactions.providerObjectId)));
  const [current] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
  return { transaction: current, replayed };
}

export interface FundingOutcomeInput {
  /** Our external_events id of the event being processed. */
  eventId: string;
  provider: string;
  /** The provider's payment as fetched from its API, not the webhook payload. */
  payment: ProviderPayment;
}

/**
 * Applies a provider funding outcome inside the event's processing transaction: locks the
 * account, re-reads the FUNDING transaction, and moves it PENDING → SETTLED (posting the ledger
 * credit) or PENDING → FAILED (no ledger effect), with trace rows. An outcome already applied is
 * a no-op.
 *
 * The transaction is found by provider_object_id, or — when the API never stored the payment id
 * (the provider call timed out after the provider created it, or the id write failed) — by the
 * `transaction_id` we put in the payment's metadata, and the id is stored now. Retryable throws:
 * that transaction isn't there yet, or the payment's status isn't final. Permanent throws (event
 * FAILED at once, for Ops): no metadata of ours, the transaction already tracks a different
 * payment, or the amount or currency differs — that credit is never posted automatically.
 */
export async function applyFundingOutcome(
  tx: Tx,
  event: FundingEvent,
  input: FundingOutcomeInput,
  logger: Logger,
): Promise<void> {
  const { payment } = input;
  const log = logger.child({ event_id: input.eventId, provider_object_id: payment.id, funding_event: event });
  const found = await findFundingTransaction(tx, input.provider, payment);

  await lockAccount(tx, found.accountId);
  const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, found.id)).for("no key update");
  const txLog = log.child({ account_id: transaction.accountId, transaction_id: transaction.id });
  if (transaction.providerObjectId !== payment.id) {
    if (transaction.providerObjectId !== null) {
      // A second payment for one transaction: e.g. a retry after the provider's idempotency window.
      throw new FundingOutcomeMismatchError(
        `transaction ${transaction.id} tracks payment ${transaction.providerObjectId}, not ${payment.id}`,
      );
    }
    await tx
      .update(transactions)
      .set({ providerObjectId: payment.id, updatedAt: sql`now()` })
      .where(and(eq(transactions.id, transaction.id), isNull(transactions.providerObjectId)));
    transaction.providerObjectId = payment.id;
    txLog.warn({ outcome: "linked_by_metadata" }, "payment id was never stored by the API; linked from the payment's metadata");
  }

  if (event === "FUNDING_FAILED" && payment.status === "SUCCEEDED") {
    // A later attempt succeeded; its payment_intent.succeeded event settles the transaction.
    countOutcome("funding_outcomes_total", { outcome: "superseded" });
    txLog.info({ outcome: "superseded" }, "funding failure superseded by a later success; no effect");
    return;
  }
  const expected = event === "FUNDING_CONFIRMED" ? "SUCCEEDED" : "FAILED";
  if (payment.status !== expected) {
    throw new FundingStatusMismatchError(`${event} but provider reports payment ${payment.id} as ${payment.status}`);
  }

  const to = fundingOutcomeStatus(event);
  if (transaction.status === to) {
    countOutcome("funding_outcomes_total", { outcome: "duplicate" });
    txLog.info({ outcome: "duplicate" }, "funding outcome already applied; no effect");
    await linkEvent(tx, input.eventId, transaction.id);
    return;
  }
  if (event === "FUNDING_CONFIRMED") {
    if (payment.currency !== transaction.currency) {
      throw new FundingOutcomeMismatchError(`payment ${payment.id} is in ${payment.currency}, transaction is ${transaction.currency}`);
    }
    if (payment.amountReceivedCents !== transaction.amountCents) {
      txLog.warn(
        { outcome: "amount_mismatch", amount_cents: transaction.amountCents, provider_amount_cents: payment.amountReceivedCents },
        "provider received a different amount than requested; not posting",
      );
      throw new FundingOutcomeMismatchError(
        `payment ${payment.id} received ${payment.amountReceivedCents} cents, transaction ${transaction.id} expects ${transaction.amountCents}`,
      );
    }
  }
  const next = nextFundingStatus(transaction.status, event);

  const updated = await tx
    .update(transactions)
    .set({ status: next, updatedAt: sql`now()` })
    .where(and(eq(transactions.id, transaction.id), eq(transactions.status, transaction.status)))
    .returning({ id: transactions.id });
  if (!updated.length) throw new Error(`Funding transaction ${transaction.id} changed status concurrently`);

  const providerRef = payment.chargeId ?? payment.id;
  if (next === "SETTLED") {
    await postLedgerEntry(
      tx,
      {
        accountId: transaction.accountId,
        transactionId: transaction.id,
        entryType: ENTRY_TYPE_FOR_TRANSACTION.FUNDING,
        amountCents: transaction.amountCents,
        externalEventId: input.eventId,
        providerRef,
      },
      txLog,
    );
  }
  await appendTraceEvent(tx, {
    accountId: transaction.accountId,
    transactionId: transaction.id,
    kind: "STATUS_CHANGED",
    amountCents: transaction.amountCents,
    fromStatus: transaction.status,
    toStatus: next,
    externalEventId: input.eventId,
    providerRef,
  });
  await linkEvent(tx, input.eventId, transaction.id);
  countOutcome("funding_outcomes_total", { outcome: next === "SETTLED" ? "settled" : "failed" });
  txLog.info({ outcome: next === "SETTLED" ? "settled" : "failed", from_status: transaction.status, to_status: next }, "funding outcome applied");
}

/**
 * The FUNDING transaction for `payment`: by provider_object_id, else by the transaction id in the
 * payment's metadata (only a transaction without a payment id, or with this one; a different id
 * is caught under the lock by the caller). Reads only; the caller locks account, then transaction.
 */
async function findFundingTransaction(tx: Tx, provider: string, payment: ProviderPayment) {
  const columns = { id: transactions.id, accountId: transactions.accountId };
  const [byPaymentId] = await tx
    .select(columns)
    .from(transactions)
    .where(and(eq(transactions.provider, provider), eq(transactions.providerObjectId, payment.id), eq(transactions.type, "FUNDING")));
  if (byPaymentId) return byPaymentId;

  const transactionId = z.uuid().safeParse(payment.metadata.transactionId);
  if (!transactionId.success) throw new FundingNotOursError(provider, payment.id);
  const [byMetadata] = await tx
    .select(columns)
    .from(transactions)
    .where(and(eq(transactions.id, transactionId.data), eq(transactions.provider, provider), eq(transactions.type, "FUNDING")));
  if (!byMetadata) throw new FundingNotFoundError(provider, payment.id, transactionId.data);
  return byMetadata;
}

/** Points the external event at the transaction it affected, for Ops. The event row is already locked by the worker. */
async function linkEvent(tx: Tx, eventId: string, transactionId: string): Promise<void> {
  await tx.update(externalEvents).set({ transactionId }).where(eq(externalEvents.id, eventId));
}
