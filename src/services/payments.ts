import { and, eq, isNull, sql } from "drizzle-orm";
import { withTransaction, type Db, type Tx } from "../db/client";
import { accounts, holds, payments, transactions } from "../db/schema";
import type { PaymentStatus } from "../domain/payments";
import type { Logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "./accounts";
import { IdempotencyConflictError, requestHash } from "./funding";
import { transitionHold } from "./holds";
import { appendTraceEvent } from "./trace";

export type Payment = typeof payments.$inferSelect;

/** Available balance can't cover the payment; nothing was created. */
export class InsufficientFundsError extends Error {
  constructor(
    readonly availableCents: number,
    readonly amountCents: number,
  ) {
    super(`Available balance ${availableCents} cents can't cover a payment of ${amountCents} cents`);
    this.name = "InsufficientFundsError";
  }
}

/** The account has no provider account to send from yet (see `npm run increase:bootstrap`). */
export class AccountNotLinkedError extends Error {
  constructor(accountId: string) {
    super(`account ${accountId} is not linked to a provider account`);
    this.name = "AccountNotLinkedError";
  }
}

export interface CreatePaymentInput {
  accountId: string;
  recipientName: string;
  accountNumber: string;
  routingNumber: string;
  amountCents: number;
  description: string | null;
  idempotencyKey: string;
}

/**
 * POST /payments. One DB transaction, under the account lock: the OUTBOUND_PAYMENT transaction
 * (PENDING), its payment row (the outbox intent the worker's submitter picks up), an ACTIVE
 * PENDING_PAYMENT hold reserving the amount, and the trace (HOLD_CREATED, then STATUS_CHANGED →
 * PENDING). No provider call: the submitter sends it after commit.
 *
 * The same key with the same body returns the existing payment; with a different body it throws
 * `IdempotencyConflictError`. If available balance can't cover the amount it throws
 * `InsufficientFundsError` and the whole transaction rolls back. The check is race-free because
 * every writer of ledger entries and holds takes the same account lock first, so available can't
 * change between the check and the hold insert; concurrent payments queue on that lock.
 */
export async function createPayment(
  db: Db,
  provider: { name: string },
  input: CreatePaymentInput,
  logger: Logger,
): Promise<{ payment: Payment; replayed: boolean }> {
  const hash = requestHash({
    type: "OUTBOUND_PAYMENT",
    recipientName: input.recipientName,
    accountNumber: input.accountNumber,
    routingNumber: input.routingNumber,
    amountCents: input.amountCents,
    description: input.description,
  });
  const log = logger.child({ account_id: input.accountId, provider: provider.name });
  const result = await withTransaction(db, async (tx) => {
    const { ledgerBalanceCents } = await lockAccount(tx, input.accountId);
    const [inserted] = await tx
      .insert(transactions)
      .values({
        accountId: input.accountId,
        type: "OUTBOUND_PAYMENT",
        status: "PENDING",
        amountCents: input.amountCents,
        provider: provider.name,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .onConflictDoNothing({ target: [transactions.accountId, transactions.idempotencyKey] })
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select({ id: transactions.id, requestHash: transactions.requestHash })
        .from(transactions)
        .where(and(eq(transactions.accountId, input.accountId), eq(transactions.idempotencyKey, input.idempotencyKey)));
      if (existing.requestHash !== hash) throw new IdempotencyConflictError(existing.id);
      const [payment] = await tx.select().from(payments).where(eq(payments.transactionId, existing.id));
      return { payment, replayed: true };
    }

    // Throwing below rolls back the transaction insert too: a refused payment leaves nothing behind.
    const [account] = await tx.select({ providerId: accounts.providerId }).from(accounts).where(eq(accounts.id, input.accountId));
    if (!account.providerId) throw new AccountNotLinkedError(input.accountId);
    const available = await accountAvailableCents(tx, input.accountId, ledgerBalanceCents);
    if (available < input.amountCents) throw new InsufficientFundsError(available, input.amountCents);

    const [payment] = await tx
      .insert(payments)
      .values({
        accountId: input.accountId,
        transactionId: inserted.id,
        recipient: input.recipientName,
        accountNumber: input.accountNumber,
        routingNumber: input.routingNumber,
        description: input.description,
        amountCents: input.amountCents,
        provider: provider.name,
      })
      .returning();
    await tx.insert(holds).values({ transactionId: inserted.id, accountId: input.accountId, kind: "PENDING_PAYMENT", amountCents: input.amountCents });
    // The effect row (HOLD_CREATED) before the no-effect one: both carry the balances after the
    // hold, which replay only accepts on the row whose effect produced them.
    const trace = { accountId: input.accountId, transactionId: inserted.id, amountCents: input.amountCents };
    await appendTraceEvent(tx, { ...trace, kind: "HOLD_CREATED", toStatus: "ACTIVE" });
    await appendTraceEvent(tx, { ...trace, kind: "STATUS_CHANGED", toStatus: "PENDING" });
    return { payment, replayed: false };
  });
  log.info(
    { outcome: result.replayed ? "replayed" : "created", transaction_id: result.payment.transactionId, payment_id: result.payment.id, amount_cents: result.payment.amountCents },
    "payment ready for submission",
  );
  return result;
}

/** The idempotency key we send the provider for a payment: one per payment, so no retry or crash can send it twice. */
export function paymentIdempotencyKey(paymentId: string): string {
  return `payment-${paymentId}`;
}

/** Statement descriptor sent with the transfer when the owner gave no description. */
export const DEFAULT_STATEMENT_DESCRIPTOR = "Payment";

/** Who is moving a payment, for its trace rows. */
export interface PaymentStep {
  /** The external event behind the change; absent for the submitter. */
  eventId?: string | null;
  providerRef?: string | null;
}

/** Reads and row-locks a payment. Call with its account already locked (lock order: account → payment). */
export async function lockPayment(tx: Tx, paymentId: string): Promise<Payment> {
  const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("no key update");
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  return payment;
}

/**
 * Conditional status move of a locked payment and its transaction (they always share a status),
 * plus its STATUS_CHANGED trace row. Zero rows updated means someone else moved it: throws, so the
 * caller's transaction rolls back.
 */
export async function setPaymentStatus(
  tx: Tx,
  payment: Payment,
  to: PaymentStatus,
  step: PaymentStep,
  extra: Partial<Pick<Payment, "providerObjectId" | "lastSubmitError">> & { submitted?: boolean } = {},
): Promise<Payment> {
  const { submitted, ...fields } = extra;
  const [updated] = await tx
    .update(payments)
    .set({ ...fields, status: to, updatedAt: sql`now()`, ...(submitted ? { submittedAt: sql`now()` } : {}) })
    .where(and(eq(payments.id, payment.id), eq(payments.status, payment.status)))
    .returning();
  const moved = await tx
    .update(transactions)
    .set({ status: to, updatedAt: sql`now()`, ...(fields.providerObjectId ? { providerObjectId: fields.providerObjectId } : {}) })
    .where(and(eq(transactions.id, payment.transactionId), eq(transactions.status, payment.status)))
    .returning({ id: transactions.id });
  if (!updated || !moved.length) throw new Error(`Payment ${payment.id} changed status concurrently; expected ${payment.status}`);
  await appendTraceEvent(tx, {
    accountId: payment.accountId,
    transactionId: payment.transactionId,
    kind: "STATUS_CHANGED",
    amountCents: payment.amountCents,
    fromStatus: payment.status,
    toStatus: to,
    externalEventId: step.eventId,
    providerRef: step.providerRef,
  });
  return updated;
}

/** PENDING → SUBMITTED: the provider accepted transfer `transferId`; stores it as the external reference. */
export function markPaymentSubmitted(tx: Tx, payment: Payment, transferId: string, step: PaymentStep): Promise<Payment> {
  return setPaymentStatus(tx, payment, "SUBMITTED", { ...step, providerRef: transferId }, { providerObjectId: transferId, lastSubmitError: null, submitted: true });
}

/**
 * → FAILED, only when we know no money left (the provider refused or rejected it): the hold is
 * released first (HOLD_RELEASED, the effect row), then the status moves.
 */
export async function failPayment(tx: Tx, payment: Payment, input: PaymentStep & { error?: string }): Promise<Payment> {
  await transitionHold(tx, { accountId: payment.accountId, transactionId: payment.transactionId, event: "RELEASE", externalEventId: input.eventId, providerRef: input.providerRef });
  return setPaymentStatus(tx, payment, "FAILED", input, input.error === undefined ? {} : { lastSubmitError: input.error });
}

/**
 * The submitter stops retrying a locked PENDING payment whose outcome at the provider is unknown:
 * `submit_gave_up_at` takes it out of the claim, the hold stays, and the trace gets a
 * STATUS_CHANGED PENDING → PENDING row (no new trace kind; the copy reads it as "couldn't
 * confirm"). A later webhook for the transfer applies the normal steps.
 */
export async function markPaymentSubmissionGivenUp(tx: Tx, payment: Payment, error: string): Promise<void> {
  const [updated] = await tx
    .update(payments)
    .set({ submitGaveUpAt: sql`now()`, lastSubmitError: error, updatedAt: sql`now()` })
    .where(and(eq(payments.id, payment.id), eq(payments.status, "PENDING"), isNull(payments.submitGaveUpAt)))
    .returning({ id: payments.id });
  if (!updated) throw new Error(`Payment ${payment.id} changed concurrently; expected PENDING and still being submitted`);
  await appendTraceEvent(tx, {
    accountId: payment.accountId,
    transactionId: payment.transactionId,
    kind: "STATUS_CHANGED",
    amountCents: payment.amountCents,
    fromStatus: "PENDING",
    toStatus: "PENDING",
  });
}

/**
 * The outbox: payments still waiting to be accepted by the provider (how many, and how long the
 * oldest has waited), and those the submitter gave up on with the outcome unknown (for Ops).
 */
export async function outboxBacklog(db: Db): Promise<{ pending: number; oldestAgeSeconds: number | null; givenUp: number }> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) FILTER (WHERE ${payments.submitGaveUpAt} IS NULL)`.mapWith(Number),
      oldestAgeSeconds: sql<number | null>`extract(epoch from now() - min(${payments.createdAt}) FILTER (WHERE ${payments.submitGaveUpAt} IS NULL))`.mapWith((value) =>
        value === null ? null : Math.round(Number(value)),
      ),
      givenUp: sql<number>`count(*) FILTER (WHERE ${payments.submitGaveUpAt} IS NOT NULL)`.mapWith(Number),
    })
    .from(payments)
    .where(eq(payments.status, "PENDING"));
  return row;
}
