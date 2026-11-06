import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withTransaction, type Db, type Tx } from "../db/client";
import { externalEvents, transactions } from "../db/schema";
import { fundingOutcomeStatus, nextFundingStatus, type FundingEvent } from "../domain/funding";
import { ENTRY_TYPE_FOR_TRANSACTION } from "../domain/ledger";
import type { PaymentProvider, ProviderPayment } from "../integrations/payment-provider";
import { safeErrorForLog, safeErrorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { lockAccount } from "./accounts";
import { postLedgerEntry } from "./ledger";
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

/** No FUNDING transaction tracks this provider payment (yet). */
export class FundingNotFoundError extends Error {
  constructor(provider: string, paymentId: string) {
    super(`No FUNDING transaction for ${provider} payment ${paymentId}`);
    this.name = "FundingNotFoundError";
  }
}

/** The provider's view of the payment doesn't support the event (wrong status, currency or amount). */
export class FundingOutcomeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingOutcomeMismatchError";
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
  if (transaction.providerObjectId) return { transaction, replayed };

  let payment: ProviderPayment;
  try {
    payment = await provider.createFundingPayment({
      amountCents: transaction.amountCents,
      idempotencyKey: providerIdempotencyKey(transaction.id),
      metadata: { transaction_id: transaction.id, account_id: transaction.accountId },
    });
  } catch (error) {
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    log.error({ outcome: "provider_error", err: safeErrorForLog(error), provider_request_id: requestId }, "funding provider call failed; transaction stays PENDING");
    throw new FundingProviderError(transaction.id, safeErrorMessage(error));
  }
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
 * a no-op. Throws (so the event retries and, if it never resolves, ends FAILED for Ops) when no
 * transaction tracks the payment, when the provider's payment doesn't support the event, or when
 * the amount received differs from ours — that credit is never posted automatically.
 */
export async function applyFundingOutcome(
  tx: Tx,
  event: FundingEvent,
  input: FundingOutcomeInput,
  logger: Logger,
): Promise<void> {
  const { payment } = input;
  const log = logger.child({ event_id: input.eventId, provider_object_id: payment.id, funding_event: event });
  const [found] = await tx
    .select({ id: transactions.id, accountId: transactions.accountId })
    .from(transactions)
    .where(
      and(
        eq(transactions.provider, input.provider),
        eq(transactions.providerObjectId, payment.id),
        eq(transactions.type, "FUNDING"),
      ),
    );
  if (!found) throw new FundingNotFoundError(input.provider, payment.id);

  await lockAccount(tx, found.accountId);
  const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, found.id)).for("no key update");
  const txLog = log.child({ account_id: transaction.accountId, transaction_id: transaction.id });

  if (event === "FUNDING_FAILED" && payment.status === "SUCCEEDED") {
    // A later attempt succeeded; its payment_intent.succeeded event settles the transaction.
    txLog.info({ outcome: "superseded" }, "funding failure superseded by a later success; no effect");
    return;
  }
  const expected = event === "FUNDING_CONFIRMED" ? "SUCCEEDED" : "FAILED";
  if (payment.status !== expected) {
    throw new FundingOutcomeMismatchError(`${event} but provider reports payment ${payment.id} as ${payment.status}`);
  }

  const to = fundingOutcomeStatus(event);
  if (transaction.status === to) {
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
  txLog.info({ outcome: next === "SETTLED" ? "settled" : "failed", from_status: transaction.status, to_status: next }, "funding outcome applied");
}

/** Points the external event at the transaction it affected, for Ops. The event row is already locked by the worker. */
async function linkEvent(tx: Tx, eventId: string, transactionId: string): Promise<void> {
  await tx.update(externalEvents).set({ transactionId }).where(eq(externalEvents.id, eventId));
}
