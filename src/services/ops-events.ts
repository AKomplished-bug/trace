import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { auditEvents, eventDeliveries, externalEvents, transactionEvents, transactions } from "../db/schema";
import { READ_SNAPSHOT } from "./account-queries";
import { recordAudit } from "./audit";
import { countOutcome } from "./metrics";
import { encodeCursor, type TransactionCursor } from "./transaction-queries";

/**
 * Ops event viewer and retry. Reads select metadata columns only: `external_events.payload` can
 * hold personal data and is never read here.
 */

type EventStatus = (typeof externalEvents.$inferSelect)["status"];

export const EVENT_AUDIT_ENTITY = "external_event";
export const EVENT_RETRY_ACTION = "event.retry";

export interface EventListFilter {
  status?: EventStatus;
  provider?: string;
  type?: string;
  limit: number;
  /** Same opaque cursor as the transaction list; `createdAt` holds the event's received_at. */
  cursor?: TransactionCursor;
}

// received_at at full (microsecond) precision for the cursor.
const receivedAtExact = sql<string>`to_char(${externalEvents.receivedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Drizzle renders columns of the queried table unqualified, which inside a correlated subquery
// would resolve to the subquery's own table; the outer event's columns are spelled out.
const outerEventId = sql.raw(`"external_events"."id"`);
const outerTransactionId = sql.raw(`"external_events"."transaction_id"`);

const metadataColumns = {
  id: externalEvents.id,
  provider: externalEvents.provider,
  externalEventId: externalEvents.externalEventId,
  eventType: externalEvents.eventType,
  status: externalEvents.status,
  attempts: externalEvents.attempts,
  nextAttemptAt: externalEvents.nextAttemptAt,
  /** Sanitized when stored (safeErrorMessage). */
  lastError: externalEvents.lastError,
  receivedAt: externalEvents.receivedAt,
  processedAt: externalEvents.processedAt,
  deliveryCount: sql<number>`(SELECT count(*) FROM ${eventDeliveries} WHERE ${eventDeliveries.externalEventId} = ${outerEventId})`.mapWith(
    Number,
  ),
  /** The transaction the event is linked to, plus every transaction its trace steps touched. */
  transactionIds: sql<string[]>`ARRAY(
    SELECT linked.id FROM (
      SELECT ${transactionEvents.transactionId} AS id FROM ${transactionEvents} WHERE ${transactionEvents.externalEventId} = ${outerEventId}
      UNION SELECT ${outerTransactionId}
    ) linked WHERE linked.id IS NOT NULL ORDER BY linked.id
  )::text[]`,
};

/** Newest first, keyset-paginated on (received_at, id); never OFFSET. */
export async function listEvents(db: Db, filter: EventListFilter) {
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(externalEvents.status, filter.status));
  if (filter.provider) conditions.push(eq(externalEvents.provider, filter.provider));
  if (filter.type) conditions.push(eq(externalEvents.eventType, filter.type));
  if (filter.cursor) {
    conditions.push(
      sql`(${externalEvents.receivedAt}, ${externalEvents.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select({ ...metadataColumns, cursorReceivedAt: receivedAtExact })
    .from(externalEvents)
    .where(and(...conditions))
    .orderBy(desc(externalEvents.receivedAt), desc(externalEvents.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const item: Partial<typeof row> = { ...row };
      delete item.cursorReceivedAt;
      return item as Omit<typeof row, "cursorReceivedAt">;
    }),
    nextCursor: rows.length > filter.limit && last ? encodeCursor({ createdAt: last.cursorReceivedAt, id: last.id }) : null,
  };
}

export type EventSummary = Awaited<ReturnType<typeof listEvents>>["items"][number];

/**
 * One event from one snapshot: its metadata, every delivery (times only), what processing left
 * behind (trace steps it wrote, the transactions they belong to, Ops actions on it). Null if
 * there is no such event.
 */
export async function getEventDetail(db: Db, eventId: string) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ ...metadataColumns, claimToken: externalEvents.claimToken, correlationId: externalEvents.correlationId })
      .from(externalEvents)
      .where(eq(externalEvents.id, eventId));
    if (!event) return null;

    const deliveries = await tx
      .select({ receivedAt: eventDeliveries.receivedAt, isDuplicate: eventDeliveries.isDuplicate })
      .from(eventDeliveries)
      .where(eq(eventDeliveries.externalEventId, eventId))
      .orderBy(asc(eventDeliveries.receivedAt));

    const steps = await tx
      .select({
        id: transactionEvents.id,
        transactionId: transactionEvents.transactionId,
        accountId: transactionEvents.accountId,
        accountSeq: transactionEvents.accountSeq,
        kind: transactionEvents.kind,
        fromStatus: transactionEvents.fromStatus,
        toStatus: transactionEvents.toStatus,
        amountCents: transactionEvents.amountCents,
        providerRef: transactionEvents.providerRef,
        occurredAt: transactionEvents.occurredAt,
      })
      .from(transactionEvents)
      .where(eq(transactionEvents.externalEventId, eventId))
      .orderBy(asc(transactionEvents.accountId), asc(transactionEvents.accountSeq));

    const touched = event.transactionIds.length
      ? await tx
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            type: transactions.type,
            status: transactions.status,
            amountCents: transactions.amountCents,
            createdAt: transactions.createdAt,
          })
          .from(transactions)
          .where(inArray(transactions.id, event.transactionIds))
          .orderBy(asc(transactions.createdAt))
      : [];

    const audit = await tx
      .select({
        id: auditEvents.id,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        action: auditEvents.action,
        previousState: auditEvents.previousState,
        newState: auditEvents.newState,
        correlationId: auditEvents.correlationId,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, EVENT_AUDIT_ENTITY), eq(auditEvents.entityId, eventId)))
      .orderBy(asc(auditEvents.createdAt));

    return { event, deliveries, steps, transactions: touched, audit };
  }, READ_SNAPSHOT);
}

export type EventDetail = NonNullable<Awaited<ReturnType<typeof getEventDetail>>>;

export type RetryResult =
  | { outcome: "retried"; event: { id: string; status: EventStatus; attempts: number; nextAttemptAt: Date } }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; status: EventStatus };

/**
 * Ops retry of a FAILED event: FAILED → RETRY with attempts reset (a fresh retry budget),
 * claim_token bumped and due now, plus its audit row, in one transaction. The event row is locked
 * first, so a concurrent or repeated retry waits and then finds RETRY: not_retryable, never a
 * second reset. Only FAILED is retryable (see docs/decision-log-full.md, "Ops retry works only
 * from FAILED").
 */
export async function retryEvent(
  db: Db,
  input: { eventId: string; userId: string; correlationId: string },
): Promise<RetryResult> {
  const result = await withTransaction(db, async (tx): Promise<RetryResult> => {
    const [before] = await tx
      .select({ status: externalEvents.status, attempts: externalEvents.attempts, claimToken: externalEvents.claimToken })
      .from(externalEvents)
      .where(eq(externalEvents.id, input.eventId))
      .for("update");
    if (!before) return { outcome: "not_found" };
    if (before.status !== "FAILED") return { outcome: "not_retryable", status: before.status };
    const [after] = await tx
      .update(externalEvents)
      .set({ status: "RETRY", attempts: 0, claimToken: sql`${externalEvents.claimToken} + 1`, nextAttemptAt: sql`now()` })
      .where(and(eq(externalEvents.id, input.eventId), eq(externalEvents.status, "FAILED")))
      .returning({
        id: externalEvents.id,
        status: externalEvents.status,
        attempts: externalEvents.attempts,
        claimToken: externalEvents.claimToken,
        nextAttemptAt: externalEvents.nextAttemptAt,
      });
    // Unreachable while we hold the row lock; a zero-row update must still never pass as a retry.
    if (!after) throw new Error(`event ${input.eventId} left FAILED while locked`);
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: EVENT_RETRY_ACTION,
      entityType: EVENT_AUDIT_ENTITY,
      entityId: input.eventId,
      previousState: { status: before.status, attempts: before.attempts, claimToken: before.claimToken },
      newState: { status: after.status, attempts: after.attempts, claimToken: after.claimToken },
      correlationId: input.correlationId,
    });
    return { outcome: "retried", event: { id: after.id, status: after.status, attempts: after.attempts, nextAttemptAt: after.nextAttemptAt } };
  });
  countOutcome("ops_event_retries_total", { outcome: result.outcome });
  return result;
}

/** Events by status, from the table (state, not a counter). */
export async function eventCountsByStatus(db: Db): Promise<Record<EventStatus, number>> {
  const rows = await db
    .select({ status: externalEvents.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(externalEvents)
    .groupBy(externalEvents.status);
  const counts = Object.fromEntries(externalEvents.status.enumValues.map((status) => [status, 0])) as Record<EventStatus, number>;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}
