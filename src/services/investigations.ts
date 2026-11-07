import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { accounts, auditEvents, businesses, investigationNotes, investigations, ledgerEntries, reconciliationRecords, reconciliationRuns, transactions } from "../db/schema";
import { internalAmountCents, suggestedAdjustmentCents } from "../domain/reconciliation";
import { logger as rootLogger, type Logger } from "../lib/logger";
import { READ_SNAPSHOT } from "./account-queries";
import { lockAccount } from "./accounts";
import { recordAudit } from "./audit";
import { requestHash } from "./funding";
import { postLedgerEntry } from "./ledger";
import { countOutcome } from "./metrics";
import { recordColumns } from "./reconciliation-queries";
import { readTransactionWithReplay } from "./replay-queries";
import type { TransactionSummary } from "./transaction-queries";
import { appendTraceEvent } from "./trace";

/**
 * Ops investigations: one per reconciliation exception. Resolving never edits history: it adds a
 * note, an audit event, optionally a new ADJUSTMENT transaction with its own ledger entry and trace,
 * and marks the record resolved — all in one transaction, conditional on the investigation still
 * being OPEN. Lock order: investigation → record → account (postLedgerEntry, appendTraceEvent).
 */

type InvestigationStatus = (typeof investigations.$inferSelect)["status"];

export const INVESTIGATION_AUDIT_ENTITY = "investigation";
export const INVESTIGATION_OPEN_ACTION = "investigation.open";
export const INVESTIGATION_NOTE_ACTION = "investigation.note";
export const INVESTIGATION_RESOLVE_ACTION = "investigation.resolve";
const LIST_LIMIT = 50;

/** The ADJUSTMENT's idempotency key: one per investigation, so a resolution can post at most once. */
export function adjustmentIdempotencyKey(investigationId: string): string {
  return `investigation-${investigationId}`;
}

export type OpenResult =
  | { outcome: "opened" | "existing"; investigation: { id: string; status: InvestigationStatus } }
  | { outcome: "record_not_found" }
  | { outcome: "not_an_exception" };

/** Opens the investigation for a reconciliation exception, or returns the one already open for it (one per record). */
export async function openInvestigation(db: Db, input: { recordId: string; userId: string; correlationId: string }): Promise<OpenResult> {
  const result = await withTransaction(db, async (tx): Promise<OpenResult> => {
    const [record] = await tx
      .select({ id: reconciliationRecords.id, status: reconciliationRecords.status, transactionId: reconciliationRecords.transactionId, accountId: reconciliationRecords.accountId })
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.id, input.recordId));
    if (!record) return { outcome: "record_not_found" };
    if (record.status === "MATCHED") return { outcome: "not_an_exception" };
    const [created] = await tx
      .insert(investigations)
      .values({ recordId: record.id, transactionId: record.transactionId, accountId: record.accountId, openedBy: input.userId })
      // Either unique index: this record's case, or the transaction's OPEN case from another run.
      .onConflictDoNothing()
      .returning({ id: investigations.id, status: investigations.status });
    if (!created) {
      const [existing] = await tx
        .select({ id: investigations.id, status: investigations.status })
        .from(investigations)
        .where(
          or(
            eq(investigations.recordId, record.id),
            record.transactionId ? and(eq(investigations.transactionId, record.transactionId), eq(investigations.status, "OPEN")) : undefined,
          ),
        )
        .orderBy(desc(eq(investigations.recordId, record.id)))
        .limit(1);
      return { outcome: "existing", investigation: existing };
    }
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: INVESTIGATION_OPEN_ACTION,
      entityType: INVESTIGATION_AUDIT_ENTITY,
      entityId: created.id,
      previousState: null,
      newState: { status: created.status, recordId: record.id, recordStatus: record.status, transactionId: record.transactionId },
      correlationId: input.correlationId,
    });
    return { outcome: "opened", investigation: created };
  });
  countOutcome("investigation_actions_total", { action: "open", outcome: result.outcome });
  return result;
}

export type NoteResult = { outcome: "added"; note: { id: string; createdAt: Date } } | { outcome: "not_found" };

/** Adds a note (with its audit row). Notes are never edited or deleted. */
export async function addNote(db: Db, input: { investigationId: string; userId: string; body: string; correlationId: string }): Promise<NoteResult> {
  const result = await withTransaction(db, async (tx): Promise<NoteResult> => {
    const [investigation] = await tx.select({ id: investigations.id, status: investigations.status }).from(investigations).where(eq(investigations.id, input.investigationId));
    if (!investigation) return { outcome: "not_found" };
    const [note] = await tx
      .insert(investigationNotes)
      .values({ investigationId: investigation.id, authorId: input.userId, body: input.body })
      .returning({ id: investigationNotes.id, createdAt: investigationNotes.createdAt });
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: INVESTIGATION_NOTE_ACTION,
      entityType: INVESTIGATION_AUDIT_ENTITY,
      entityId: investigation.id,
      previousState: null,
      newState: { noteId: note.id, status: investigation.status },
      correlationId: input.correlationId,
    });
    return { outcome: "added", note };
  });
  countOutcome("investigation_actions_total", { action: "note", outcome: result.outcome });
  return result;
}

export type ResolveResult =
  | { outcome: "resolved"; investigation: { id: string; status: InvestigationStatus; transactionId: string | null; adjustmentTransactionId: string | null } }
  | { outcome: "not_found" }
  | { outcome: "already_resolved" }
  /** An adjustment only fits an AMOUNT_MISMATCH whose transaction has posted. */
  | { outcome: "adjustment_not_allowed" }
  /** The adjustment doesn't exactly close the gap to the provider's amount as it stands now (null: no gap left). */
  | { outcome: "adjustment_mismatch"; expectedCents: number | null };

/**
 * Resolves an OPEN investigation in one transaction: the resolution note; with `adjustmentCents`
 * (signed: credit +, debit −; only for an AMOUNT_MISMATCH whose transaction has posted, and only
 * the exact amount that brings the transaction's current posted net — its own entry plus linked
 * ADJUSTMENTs, read under the account lock — to the provider's amount), a new SETTLED ADJUSTMENT linked to the investigated transaction,
 * posted through `postLedgerEntry` (LEDGER_POSTED, then its STATUS_CHANGED: rule 10); the record
 * marked resolved; the investigation RESOLVED; the audit row. The investigation row is locked
 * first, so a double submit waits and then finds RESOLVED (already_resolved) and posts nothing.
 */
export async function resolveInvestigation(
  db: Db,
  input: { investigationId: string; userId: string; note: string; adjustmentCents?: number; correlationId: string },
  logger: Logger = rootLogger,
): Promise<ResolveResult> {
  const log = logger.child({ investigation_id: input.investigationId, correlation_id: input.correlationId });
  const result = await withTransaction(db, async (tx): Promise<ResolveResult> => {
    const [investigation] = await tx.select().from(investigations).where(eq(investigations.id, input.investigationId)).for("update");
    if (!investigation) return { outcome: "not_found" };
    if (investigation.status !== "OPEN") return { outcome: "already_resolved" };
    const [record] = await tx
      .select({
        id: reconciliationRecords.id,
        status: reconciliationRecords.status,
        transactionType: reconciliationRecords.transactionType,
        externalAmountCents: reconciliationRecords.externalAmountCents,
      })
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.id, investigation.recordId))
      .for("update");

    let adjustmentTransactionId: string | null = null;
    if (input.adjustmentCents !== undefined) {
      const { transactionId, accountId } = investigation;
      if (record.status !== "AMOUNT_MISMATCH" || !transactionId || !accountId || record.externalAmountCents === null) return { outcome: "adjustment_not_allowed" };
      await lockAccount(tx, accountId);
      // Under the account lock: what the transaction has posted now, including adjustments since the run.
      const [own] = await tx
        .select({ cents: sql<number | null>`sum(${ledgerEntries.amountCents})`.mapWith((v) => (v === null ? null : Number(v))) })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, transactionId));
      if (own.cents === null) return { outcome: "adjustment_not_allowed" };
      const [adjusted] = await tx
        .select({ cents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`.mapWith(Number) })
        .from(transactions)
        .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, transactions.id))
        .where(and(eq(transactions.type, "ADJUSTMENT"), eq(transactions.relatedTransactionId, transactionId)));
      const currentCents = internalAmountCents(0, own.cents + adjusted.cents);
      const expectedCents = suggestedAdjustmentCents(record.transactionType, record.externalAmountCents - currentCents);
      if (input.adjustmentCents !== expectedCents) return { outcome: "adjustment_mismatch", expectedCents };
      const [adjustment] = await tx
        .insert(transactions)
        .values({
          accountId,
          type: "ADJUSTMENT",
          status: "SETTLED",
          amountCents: Math.abs(input.adjustmentCents),
          relatedTransactionId: transactionId,
          idempotencyKey: adjustmentIdempotencyKey(investigation.id),
          requestHash: requestHash({ type: "ADJUSTMENT", investigationId: investigation.id, adjustmentCents: input.adjustmentCents }),
        })
        .returning({ id: transactions.id });
      adjustmentTransactionId = adjustment.id;
      await postLedgerEntry(tx, { accountId, transactionId: adjustment.id, entryType: "ADJUSTMENT", amountCents: input.adjustmentCents }, log);
      await appendTraceEvent(tx, { accountId, transactionId: adjustment.id, kind: "STATUS_CHANGED", amountCents: Math.abs(input.adjustmentCents), toStatus: "SETTLED" });
    }

    await tx.insert(investigationNotes).values({ investigationId: investigation.id, authorId: input.userId, body: input.note });
    const [resolved] = await tx
      .update(investigations)
      .set({ status: "RESOLVED", resolvedBy: input.userId, resolvedAt: sql`now()`, adjustmentTransactionId })
      .where(and(eq(investigations.id, investigation.id), eq(investigations.status, "OPEN")))
      .returning({
        id: investigations.id,
        status: investigations.status,
        transactionId: investigations.transactionId,
        adjustmentTransactionId: investigations.adjustmentTransactionId,
      });
    const marked = await tx
      .update(reconciliationRecords)
      .set({ resolvedAt: sql`now()` })
      .where(and(eq(reconciliationRecords.id, record.id), isNull(reconciliationRecords.resolvedAt)))
      .returning({ id: reconciliationRecords.id });
    // Unreachable while we hold both row locks; a zero-row update must still never pass as resolved.
    if (!resolved || marked.length === 0) throw new Error(`investigation ${investigation.id} or its record changed while locked`);
    await recordAudit(tx, {
      actorUserId: input.userId,
      action: INVESTIGATION_RESOLVE_ACTION,
      entityType: INVESTIGATION_AUDIT_ENTITY,
      entityId: investigation.id,
      previousState: { status: investigation.status, recordId: record.id, recordStatus: record.status },
      newState: { status: resolved.status, adjustmentTransactionId, adjustmentCents: input.adjustmentCents ?? null },
      correlationId: input.correlationId,
    });
    return { outcome: "resolved", investigation: resolved };
  });
  countOutcome("investigation_actions_total", { action: "resolve", outcome: result.outcome === "resolved" && result.investigation.adjustmentTransactionId ? "resolved_with_adjustment" : result.outcome });
  if (result.outcome === "resolved") {
    const { transactionId, adjustmentTransactionId } = result.investigation;
    log.info({ outcome: "resolved", transaction_id: transactionId, adjustment_transaction_id: adjustmentTransactionId }, "investigation resolved");
  }
  return result;
}

const investigationColumns = {
  id: investigations.id,
  status: investigations.status,
  recordId: investigations.recordId,
  transactionId: investigations.transactionId,
  accountId: investigations.accountId,
  openedBy: investigations.openedBy,
  resolvedBy: investigations.resolvedBy,
  adjustmentTransactionId: investigations.adjustmentTransactionId,
  createdAt: investigations.createdAt,
  resolvedAt: investigations.resolvedAt,
};

/** Newest first, optionally one status; with each one's record summary. */
export async function listInvestigations(db: Db, filter: { status?: InvestigationStatus }) {
  return db
    .select({
      ...investigationColumns,
      recordStatus: reconciliationRecords.status,
      transactionType: reconciliationRecords.transactionType,
      differenceCents: recordColumns.differenceCents,
      businessName: businesses.name,
    })
    .from(investigations)
    .innerJoin(reconciliationRecords, eq(reconciliationRecords.id, investigations.recordId))
    .leftJoin(accounts, eq(accounts.id, investigations.accountId))
    .leftJoin(businesses, eq(businesses.id, accounts.businessId))
    .where(filter.status ? eq(investigations.status, filter.status) : undefined)
    .orderBy(desc(investigations.createdAt), desc(investigations.id))
    .limit(LIST_LIMIT);
}

/**
 * One investigation from one snapshot: the record (with its run's provider), the transaction's
 * money trace and replay verdict, the adjustment if one was posted, the notes timeline and the audit
 * trail. Ids, amounts and statuses only: no provider payloads, no counterparty or payee names.
 */
export async function getInvestigationDetail(db: Db, investigationId: string, log: Logger = rootLogger) {
  return db.transaction(async (tx) => {
    const [investigation] = await tx
      .select({ ...investigationColumns, businessName: businesses.name })
      .from(investigations)
      .leftJoin(accounts, eq(accounts.id, investigations.accountId))
      .leftJoin(businesses, eq(businesses.id, accounts.businessId))
      .where(eq(investigations.id, investigationId));
    if (!investigation) return null;
    const [record] = await tx
      .select({ ...recordColumns, provider: reconciliationRuns.provider })
      .from(reconciliationRecords)
      .innerJoin(reconciliationRuns, eq(reconciliationRuns.id, reconciliationRecords.runId))
      .leftJoin(investigations, eq(investigations.recordId, reconciliationRecords.id))
      .where(eq(reconciliationRecords.id, investigation.recordId));
    const full =
      investigation.transactionId && investigation.accountId ? await readTransactionWithReplay(tx, investigation.accountId, investigation.transactionId, log) : null;
    // Ops sees ids, amounts, statuses and steps; not who the money moved with (a payee can be a person).
    const trace = full && {
      transaction: withoutParties(full.detail.transaction),
      ledgerEntries: full.detail.ledgerEntries,
      holds: full.detail.holds,
      related: full.detail.related.map(withoutParties),
      externalEvents: full.detail.external.events,
      steps: full.steps,
      replay: { consistent: full.replay.consistent, divergence: full.replay.divergence },
    };
    const [adjustment] = investigation.adjustmentTransactionId
      ? await tx
          .select({ id: transactions.id, status: transactions.status, amountCents: transactions.amountCents, createdAt: transactions.createdAt })
          .from(transactions)
          .where(eq(transactions.id, investigation.adjustmentTransactionId))
      : [];
    const notes = await tx
      .select({ id: investigationNotes.id, authorId: investigationNotes.authorId, body: investigationNotes.body, createdAt: investigationNotes.createdAt })
      .from(investigationNotes)
      .where(eq(investigationNotes.investigationId, investigationId))
      .orderBy(asc(investigationNotes.createdAt), asc(investigationNotes.id));
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
      .where(and(eq(auditEvents.entityType, INVESTIGATION_AUDIT_ENTITY), eq(auditEvents.entityId, investigationId)))
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
    return { investigation, record, trace, adjustment: adjustment ?? null, notes, audit };
  }, READ_SNAPSHOT);
}

/** The transaction fields Ops sees: ids, amounts and statuses, never who the money moved with. */
type OpsTransactionFields =
  | "id"
  | "type"
  | "status"
  | "amountCents"
  | "currency"
  | "provider"
  | "providerObjectId"
  | "relatedTransactionId"
  | "postedCents"
  | "holdCents"
  | "holdStatus"
  | "createdAt";

function withoutParties(row: Pick<TransactionSummary, OpsTransactionFields> & { relation?: "original" | "follow_up" }) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    provider: row.provider,
    providerObjectId: row.providerObjectId,
    relatedTransactionId: row.relatedTransactionId,
    postedCents: row.postedCents,
    holdCents: row.holdCents,
    holdStatus: row.holdStatus,
    createdAt: row.createdAt,
    relation: row.relation,
  };
}

export type InvestigationDetail = NonNullable<Awaited<ReturnType<typeof getInvestigationDetail>>>;
