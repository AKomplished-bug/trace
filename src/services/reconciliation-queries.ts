import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { accounts, auditEvents, businesses, investigations, reconciliationRecords, reconciliationRuns } from "../db/schema";
import { countByStatus, type ReconciliationStatus } from "../domain/reconciliation";
import { READ_SNAPSHOT } from "./account-queries";
import { RUN_AUDIT_ENTITY } from "./reconciliation";

/**
 * Ops reads for reconciliation: runs, each run's records side by side, and the open exceptions
 * queue. Ids, amounts and statuses only: no provider payloads, no personal data.
 */

const RUN_LIST_LIMIT = 20;

const runColumns = {
  id: reconciliationRuns.id,
  provider: reconciliationRuns.provider,
  windowStart: reconciliationRuns.windowStart,
  windowEnd: reconciliationRuns.windowEnd,
  status: reconciliationRuns.status,
  attempts: reconciliationRuns.attempts,
  /** Sanitized when stored (safeErrorMessage). */
  lastError: reconciliationRuns.lastError,
  matchedCount: reconciliationRuns.matchedCount,
  exceptionCount: reconciliationRuns.exceptionCount,
  requestedBy: reconciliationRuns.requestedBy,
  createdAt: reconciliationRuns.createdAt,
  finishedAt: reconciliationRuns.finishedAt,
};

export const recordColumns = {
  id: reconciliationRecords.id,
  runId: reconciliationRecords.runId,
  status: reconciliationRecords.status,
  reason: reconciliationRecords.reason,
  transactionType: reconciliationRecords.transactionType,
  transactionId: reconciliationRecords.transactionId,
  accountId: reconciliationRecords.accountId,
  externalId: reconciliationRecords.externalId,
  externalRef: reconciliationRecords.externalRef,
  internalAmountCents: reconciliationRecords.internalAmountCents,
  externalAmountCents: reconciliationRecords.externalAmountCents,
  /** External − internal, when both sides have an amount. */
  differenceCents: sql<number | null>`${reconciliationRecords.externalAmountCents} - ${reconciliationRecords.internalAmountCents}`.mapWith((v) =>
    v === null ? null : Number(v),
  ),
  internalStatus: reconciliationRecords.internalStatus,
  externalStatus: reconciliationRecords.externalStatus,
  resolvedAt: reconciliationRecords.resolvedAt,
  createdAt: reconciliationRecords.createdAt,
  investigationId: investigations.id,
  investigationStatus: investigations.status,
};

/** Each provider's latest SUCCEEDED run: the current picture. */
function latestRunIds(tx: Tx) {
  return tx
    .selectDistinctOn([reconciliationRuns.provider], { id: reconciliationRuns.id, provider: reconciliationRuns.provider })
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.status, "SUCCEEDED"))
    .orderBy(reconciliationRuns.provider, desc(reconciliationRuns.finishedAt));
}

/**
 * The reconciliation dashboard from one snapshot: recent runs, counts by status across each
 * provider's latest successful run, and its open exceptions (not MATCHED, not resolved), oldest
 * first, optionally one status only.
 */
export async function getReconciliationOverview(db: Db, filter: { status?: ReconciliationStatus }) {
  return db.transaction(async (tx) => {
    const runs = await tx.select(runColumns).from(reconciliationRuns).orderBy(desc(reconciliationRuns.createdAt), desc(reconciliationRuns.id)).limit(RUN_LIST_LIMIT);
    const latest = await latestRunIds(tx);
    const runIds = latest.map((r) => r.id);
    if (runIds.length === 0) return { runs, latestRunIds: runIds, counts: countByStatus([]), exceptions: [] };

    const statusRows = await tx
      .select({ status: reconciliationRecords.status, count: sql<number>`count(*)`.mapWith(Number) })
      .from(reconciliationRecords)
      .where(inArray(reconciliationRecords.runId, runIds))
      .groupBy(reconciliationRecords.status);
    const counts = countByStatus([]);
    for (const row of statusRows) counts[row.status] = row.count;

    const exceptions = await tx
      .select({ ...recordColumns, provider: reconciliationRuns.provider, businessName: businesses.name })
      .from(reconciliationRecords)
      .innerJoin(reconciliationRuns, eq(reconciliationRuns.id, reconciliationRecords.runId))
      .leftJoin(accounts, eq(accounts.id, reconciliationRecords.accountId))
      .leftJoin(businesses, eq(businesses.id, accounts.businessId))
      .leftJoin(investigations, eq(investigations.recordId, reconciliationRecords.id))
      .where(
        and(
          inArray(reconciliationRecords.runId, runIds),
          filter.status ? eq(reconciliationRecords.status, filter.status) : ne(reconciliationRecords.status, "MATCHED"),
          isNull(reconciliationRecords.resolvedAt),
        ),
      )
      .orderBy(asc(reconciliationRecords.createdAt), asc(reconciliationRecords.id));
    return { runs, latestRunIds: runIds, counts, exceptions };
  }, READ_SNAPSHOT);
}

export type ReconciliationOverview = Awaited<ReturnType<typeof getReconciliationOverview>>;
export type ExceptionView = ReconciliationOverview["exceptions"][number];

/** One run with every record (internal and external side by side) and its Ops actions, from one snapshot. Null if there is no such run. */
export async function getRunDetail(db: Db, runId: string) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select(runColumns).from(reconciliationRuns).where(eq(reconciliationRuns.id, runId));
    if (!run) return null;
    const records = await tx
      .select(recordColumns)
      .from(reconciliationRecords)
      .leftJoin(investigations, eq(investigations.recordId, reconciliationRecords.id))
      .where(eq(reconciliationRecords.runId, runId))
      .orderBy(asc(reconciliationRecords.status), asc(reconciliationRecords.createdAt), asc(reconciliationRecords.id));
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
      .where(and(eq(auditEvents.entityType, RUN_AUDIT_ENTITY), eq(auditEvents.entityId, runId)))
      .orderBy(asc(auditEvents.createdAt));
    return { run, records, audit };
  }, READ_SNAPSHOT);
}

export type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunDetail>>>;
export type RecordView = RunDetail["records"][number];
