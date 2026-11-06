import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { holds, ledgerEntries, payments, transactions } from "../db/schema";
import { encodeCursor, type TransactionCursor } from "./transaction-queries";

const returns = alias(transactions, "payment_returns");

// The owner-facing payment: never the full account number (last four digits only). Each joined
// table has at most one row per payment (one ledger entry and one hold per transaction; one
// PAYMENT_RETURN per transfer), so the joins never multiply rows.
const columns = {
  id: payments.id,
  transactionId: payments.transactionId,
  status: payments.status,
  amountCents: payments.amountCents,
  currency: payments.currency,
  recipientName: payments.recipient,
  accountNumberLast4: sql<string>`right(${payments.accountNumber}, 4)`,
  routingNumber: payments.routingNumber,
  description: payments.description,
  provider: payments.provider,
  /** The external reference: the provider's transfer id, once it has accepted the payment. */
  providerObjectId: payments.providerObjectId,
  submitAttempts: payments.submitAttempts,
  submittedAt: payments.submittedAt,
  createdAt: payments.createdAt,
  updatedAt: payments.updatedAt,
  /** Signed ledger effect once completed; null before. */
  postedCents: ledgerEntries.amountCents,
  holdCents: holds.amountCents,
  holdStatus: holds.status,
  /** The PAYMENT_RETURN that credited the money back after completion, if any. */
  returnTransactionId: returns.id,
};

function selectPayments<Extra extends Record<string, SQL.Aliased | ReturnType<typeof sql>>>(db: Pick<Db, "select">, extra: Extra = {} as Extra) {
  return db
    .select({ ...columns, ...extra })
    .from(payments)
    .leftJoin(ledgerEntries, eq(ledgerEntries.transactionId, payments.transactionId))
    .leftJoin(holds, eq(holds.transactionId, payments.transactionId))
    .leftJoin(returns, and(eq(returns.relatedTransactionId, payments.transactionId), eq(returns.type, "PAYMENT_RETURN")));
}

export type PaymentSummary = Awaited<ReturnType<ReturnType<typeof selectPayments<Record<string, never>>>["execute"]>>[number];

/** One payment, or null unless it belongs to `accountId`. */
export async function getPayment(db: Db, accountId: string, paymentId: string): Promise<PaymentSummary | null> {
  const [payment] = await selectPayments(db, {} as Record<string, never>).where(and(eq(payments.id, paymentId), eq(payments.accountId, accountId)));
  return payment ?? null;
}

const createdAtExact = sql<string>`to_char(${payments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Newest first, keyset-paginated on (created_at, id) over payments_account_created_idx. */
export async function listPayments(db: Db, accountId: string, filter: { limit: number; cursor?: TransactionCursor }) {
  const conditions: SQL[] = [eq(payments.accountId, accountId)];
  if (filter.cursor) {
    conditions.push(sql`(${payments.createdAt}, ${payments.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`);
  }
  const rows = await selectPayments(db, { cursorCreatedAt: createdAtExact })
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const item: Partial<typeof row> = { ...row };
      delete item.cursorCreatedAt;
      return item as PaymentSummary;
    }),
    nextCursor: rows.length > filter.limit && last ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
  };
}
