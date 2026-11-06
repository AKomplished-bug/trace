import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client";
import { externalEvents, holds, ledgerEntries, payments, transactionEvents, transactions } from "../db/schema";
import { READ_SNAPSHOT } from "./account-queries";

type Transaction = typeof transactions.$inferSelect;

export interface TransactionListFilter {
  type?: Transaction["type"];
  status?: Transaction["status"];
  limit: number;
  cursor?: TransactionCursor;
}

/** Position after the last row of a page: created_at at full (microsecond) precision, then id. */
export interface TransactionCursor {
  createdAt: string;
  id: string;
}

const cursorSchema = z.object({ createdAt: z.iso.datetime({ precision: 6 }), id: z.uuid() });

export function encodeCursor(cursor: TransactionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The cursor, or null if it isn't one we issued. */
export function decodeCursor(value: string): TransactionCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Each joined table has at most one row per transaction (UNIQUE transaction_id on holds and
// payments; one ledger entry per transaction), so these joins never multiply rows.
const summaryColumns = {
  id: transactions.id,
  type: transactions.type,
  status: transactions.status,
  amountCents: transactions.amountCents,
  currency: transactions.currency,
  provider: transactions.provider,
  providerObjectId: transactions.providerObjectId,
  relatedTransactionId: transactions.relatedTransactionId,
  /** Merchant or other party, when the provider names one (e.g. a card purchase's merchant). */
  counterparty: transactions.counterparty,
  createdAt: transactions.createdAt,
  updatedAt: transactions.updatedAt,
  /** Signed ledger effect once posted; null while pending. */
  postedCents: ledgerEntries.amountCents,
  /** The hold this transaction placed (card authorization or pending payment), if any. */
  holdCents: holds.amountCents,
  holdStatus: holds.status,
  recipient: payments.recipient,
};

function summaries<Extra extends Record<string, SQL.Aliased | ReturnType<typeof sql>>>(
  db: Pick<Db, "select">,
  extra: Extra = {} as Extra,
) {
  return db
    .select({ ...summaryColumns, ...extra })
    .from(transactions)
    .leftJoin(ledgerEntries, eq(ledgerEntries.transactionId, transactions.id))
    .leftJoin(holds, eq(holds.transactionId, transactions.id))
    .leftJoin(payments, eq(payments.transactionId, transactions.id));
}

export type TransactionSummary = Awaited<ReturnType<ReturnType<typeof summaries<Record<string, never>>>["execute"]>>[number];

// created_at at full precision for the cursor (a JS Date would drop the microseconds).
const createdAtExact = sql<string>`to_char(${transactions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Newest first, keyset-paginated on (created_at, id) over transactions_account_created_idx. */
export async function listTransactions(db: Db, accountId: string, filter: TransactionListFilter) {
  const conditions: SQL[] = [eq(transactions.accountId, accountId)];
  if (filter.type) conditions.push(eq(transactions.type, filter.type));
  if (filter.status) conditions.push(eq(transactions.status, filter.status));
  if (filter.cursor) {
    conditions.push(
      sql`(${transactions.createdAt}, ${transactions.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }
  const rows = await summaries(db, { cursorCreatedAt: createdAtExact })
    .where(and(...conditions))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const item: Partial<typeof row> = { ...row };
      delete item.cursorCreatedAt;
      return item as TransactionSummary;
    }),
    nextCursor: rows.length > filter.limit && last ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
  };
}

/**
 * Everything the transaction detail needs, from one snapshot: the transaction, its ledger
 * entries and hold, linked transactions (the original it reverses/returns, and anything
 * reversing/returning it) and the external records behind it. Null unless it belongs to
 * `accountId`.
 */
export async function getTransactionDetail(db: Db, accountId: string, transactionId: string) {
  return db.transaction((tx) => readDetail(tx, accountId, transactionId), READ_SNAPSHOT);
}

export async function readDetail(tx: Tx, accountId: string, transactionId: string) {
  const [transaction] = await summaries(tx).where(
    and(eq(transactions.id, transactionId), eq(transactions.accountId, accountId)),
  );
  if (!transaction) return null;

  const entries = await tx
    .select({
      id: ledgerEntries.id,
      entryType: ledgerEntries.entryType,
      amountCents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
      externalEventId: ledgerEntries.externalEventId,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, transactionId))
    .orderBy(asc(ledgerEntries.createdAt));

  const transactionHolds = await tx
    .select({
      id: holds.id,
      kind: holds.kind,
      status: holds.status,
      amountCents: holds.amountCents,
      createdAt: holds.createdAt,
      expiresAt: holds.expiresAt,
      releasedAt: holds.releasedAt,
    })
    .from(holds)
    .where(eq(holds.transactionId, transactionId));

  const links = [eq(transactions.relatedTransactionId, transactionId)];
  if (transaction.relatedTransactionId) links.push(eq(transactions.id, transaction.relatedTransactionId));
  const related = (await summaries(tx).where(and(eq(transactions.accountId, accountId), or(...links))).orderBy(asc(transactions.createdAt))).map(
    (row) => ({ ...row, relation: row.id === transaction.relatedTransactionId ? ("original" as const) : ("follow_up" as const) }),
  );

  // External events behind this transaction's ledger entries and trace steps (primary-key lookups).
  const traceEventIds = await tx
    .selectDistinct({ id: transactionEvents.externalEventId })
    .from(transactionEvents)
    .where(eq(transactionEvents.transactionId, transactionId));
  const eventIds = [
    ...new Set([...entries.map((e) => e.externalEventId), ...traceEventIds.map((e) => e.id)].filter((id): id is string => id !== null)),
  ];
  const events = eventIds.length
    ? await tx
        .select({
          id: externalEvents.id,
          provider: externalEvents.provider,
          externalEventId: externalEvents.externalEventId,
          eventType: externalEvents.eventType,
          status: externalEvents.status,
          receivedAt: externalEvents.receivedAt,
          processedAt: externalEvents.processedAt,
        })
        .from(externalEvents)
        .where(inArray(externalEvents.id, eventIds))
        .orderBy(asc(externalEvents.receivedAt))
    : [];

  return {
    transaction,
    ledgerEntries: entries,
    holds: transactionHolds,
    related,
    external: { provider: transaction.provider, providerObjectId: transaction.providerObjectId, events },
  };
}

export type TransactionDetail = NonNullable<Awaited<ReturnType<typeof readDetail>>>;

/**
 * The money trace: every step in `account_seq` order (the order they happened on the account;
 * never `occurred_at`) with the ledger and available balance right after it, and the provider
 * element / external event behind it. Null unless the transaction belongs to `accountId`.
 */
export async function getTimeline(db: Db, accountId: string, transactionId: string) {
  return db.transaction((tx) => readTimeline(tx, accountId, transactionId), READ_SNAPSHOT);
}

export async function readTimeline(tx: Tx, accountId: string, transactionId: string) {
  const [owned] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.accountId, accountId)));
  if (!owned) return null;
  return tx
    .select({
      id: transactionEvents.id,
      seq: transactionEvents.seq,
      accountSeq: transactionEvents.accountSeq,
      kind: transactionEvents.kind,
      occurredAt: transactionEvents.occurredAt,
      amountCents: transactionEvents.amountCents,
      fromStatus: transactionEvents.fromStatus,
      toStatus: transactionEvents.toStatus,
      ledgerDeltaCents: transactionEvents.ledgerDeltaCents,
      ledgerBalanceAfterCents: transactionEvents.ledgerBalanceAfterCents,
      availableAfterCents: transactionEvents.availableAfterCents,
      ledgerEntryId: transactionEvents.ledgerEntryId,
      providerRef: transactionEvents.providerRef,
      provider: externalEvents.provider,
      /** The provider's event id (our external_events row is `eventId`). */
      externalEventId: externalEvents.externalEventId,
      eventId: transactionEvents.externalEventId,
    })
    .from(transactionEvents)
    .leftJoin(externalEvents, eq(externalEvents.id, transactionEvents.externalEventId))
    .where(eq(transactionEvents.transactionId, transactionId))
    .orderBy(asc(transactionEvents.accountSeq));
}

export type TimelineStep = NonNullable<Awaited<ReturnType<typeof readTimeline>>>[number];
