import { and, eq } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { accounts, holds, payments, transactions } from "../db/schema";
import type { Logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "./accounts";
import { IdempotencyConflictError, requestHash } from "./funding";
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
