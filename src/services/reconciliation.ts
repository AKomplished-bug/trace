import { and, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withTransaction, type Db, type Tx } from "../db/client";
import { alias } from "drizzle-orm/pg-core";
import { accounts, cards, ledgerEntries, payments, reconciliationRecords, reconciliationRuns, transactionEvents, transactions } from "../db/schema";
import {
  cardPaymentRecords,
  classify,
  countByStatus,
  fundingRecord,
  internalAmountCents,
  transferRecords,
  type ExternalRecord,
  type InternalRecord,
  type ReconciledType,
} from "../domain/reconciliation";
import type { CardProvider, ListedCardPayment } from "../integrations/card-provider";
import { ProviderRejectedError, type ListedPayment, type ListWindow, type PaymentProvider } from "../integrations/payment-provider";
import type { ListedTransfer, TransferProvider } from "../integrations/transfer-provider";
import { safeErrorForLog, safeErrorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { recordAudit } from "./audit";
import { countAfterCommit, countOutcome } from "./metrics";
import { PAYMENT_KEY } from "./payments";

/**
 * Reconciliation runs. A run row is the job: `requestRun` creates it (one PENDING/RUNNING run per
 * provider, by a partial unique index), the worker claims it like an event (attempts,
 * claim_token fence, lease in next_attempt_at), fetches the provider's records with no
 * transaction open, then classifies and stores every record and marks the run SUCCEEDED in one
 * transaction. A failed fetch marks it FAILED; Ops can retry it.
 */

type RunStatus = (typeof reconciliationRuns.$inferSelect)["status"];

export const RUN_AUDIT_ENTITY = "reconciliation_run";
export const RUN_REQUEST_ACTION = "reconciliation.run";
export const RUN_RETRY_ACTION = "reconciliation.retry";
/** A side that changed this recently may still be catching up (event retries take up to ~36 min). */
export const RECONCILIATION_GRACE_MS = 60 * 60_000;
/** Provider records are fetched this far beyond the window, so a pair split across its edge still pairs. */
export const FETCH_MARGIN_MS = 60 * 60_000;
/** Deadline for the whole fetch phase; each page call also has the adapter's 10 s timeout. */
export const RUN_FETCH_TIMEOUT_MS = 60_000;
/** Claims (worker crash or lease expiry) before a run is FAILED without running again. */
export const MAX_RUN_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 1_000;
const INSERT_BATCH = 500;
/** Parents retrieved one by one (late refunds and returns) per run; more fails the run rather than overrunning the deadline. */
export const MAX_PARENT_RETRIEVALS = 100;
const ACTIVE_RUN_KEY = "reconciliation_runs_active_provider_key";

/** Where a provider's records come from; the worker wires the configured adapters. */
export interface ReconciliationSource {
  payments?: Pick<PaymentProvider, "listPayments">;
  cards?: Pick<CardProvider, "listCardPayments" | "retrieveCardPayment">;
  transfers?: Pick<TransferProvider, "listTransfers" | "retrieveTransfer">;
  /**
   * Our provider-side ids, so lists return only our records: card payments per card, transfers per
   * account. When absent, read from `cards.provider_id` and `accounts.provider_id`.
   */
  scope?: { cardIds: readonly string[]; accountIds: readonly string[] };
}

export type ReconciliationSources = Readonly<Record<string, ReconciliationSource>>;

const runColumns = {
  id: reconciliationRuns.id,
  provider: reconciliationRuns.provider,
  windowStart: reconciliationRuns.windowStart,
  windowEnd: reconciliationRuns.windowEnd,
  status: reconciliationRuns.status,
  attempts: reconciliationRuns.attempts,
  nextAttemptAt: reconciliationRuns.nextAttemptAt,
  lastError: reconciliationRuns.lastError,
  matchedCount: reconciliationRuns.matchedCount,
  exceptionCount: reconciliationRuns.exceptionCount,
  requestedBy: reconciliationRuns.requestedBy,
  createdAt: reconciliationRuns.createdAt,
  finishedAt: reconciliationRuns.finishedAt,
};

const selectRuns = (db: Db | Tx) => db.select(runColumns).from(reconciliationRuns);
export type RunSummary = Awaited<ReturnType<ReturnType<typeof selectRuns>["execute"]>>[number];

const activeRun = () => inArray(reconciliationRuns.status, ["PENDING", "RUNNING"]);

export type RequestRunResult = { outcome: "created" | "already_active"; run: RunSummary };

/**
 * Creates a PENDING run for `provider` and `window`, with its audit row, unless the provider already
 * has a PENDING or RUNNING run: then that run is returned and nothing is written. A concurrent
 * request waits on the unique index and then finds the winner's run.
 */
export async function requestRun(
  db: Db,
  input: { provider: string; window: ListWindow; userId: string; correlationId: string },
): Promise<RequestRunResult> {
  const result = await withTransaction(db, async (tx): Promise<RequestRunResult> => {
    const [created] = await tx
      .insert(reconciliationRuns)
      .values({
        provider: input.provider,
        windowStart: input.window.start,
        windowEnd: input.window.end,
        requestedBy: input.userId,
        correlationId: input.correlationId,
      })
      .onConflictDoNothing()
      .returning(runColumns);
    if (created) {
      await recordAudit(tx, {
        actorUserId: input.userId,
        action: RUN_REQUEST_ACTION,
        entityType: RUN_AUDIT_ENTITY,
        entityId: created.id,
        previousState: null,
        newState: { status: created.status, provider: created.provider, windowStart: created.windowStart.toISOString(), windowEnd: created.windowEnd.toISOString() },
        correlationId: input.correlationId,
      });
      return { outcome: "created", run: created };
    }
    const [active] = await selectRuns(tx).where(and(eq(reconciliationRuns.provider, input.provider), activeRun()));
    // The conflicting run finished between our insert and this read: the caller can ask again.
    if (!active) throw new Error(`reconciliation run for ${input.provider} conflicted but no active run was found`);
    return { outcome: "already_active", run: active };
  });
  countOutcome("reconciliation_requests_total", { outcome: result.outcome });
  return result;
}

export type RetryRunResult =
  | { outcome: "retried"; run: RunSummary }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; status: RunStatus }
  | { outcome: "already_active" };

/**
 * Ops retry of a FAILED run: FAILED → PENDING with a fresh budget, claim_token bumped, due now, and
 * its audit row, under the run row lock (a second or concurrent retry sees PENDING: not_retryable).
 * If the provider meanwhile has another active run, nothing changes: already_active.
 */
export async function retryRun(db: Db, input: { runId: string; userId: string; correlationId: string }): Promise<RetryRunResult> {
  let result: RetryRunResult;
  try {
    result = await withTransaction(db, async (tx): Promise<RetryRunResult> => {
      const [before] = await tx
        .select({ status: reconciliationRuns.status, attempts: reconciliationRuns.attempts, claimToken: reconciliationRuns.claimToken })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, input.runId))
        .for("update");
      if (!before) return { outcome: "not_found" };
      if (before.status !== "FAILED") return { outcome: "not_retryable", status: before.status };
      const [after] = await tx
        .update(reconciliationRuns)
        .set({ status: "PENDING", attempts: 0, claimToken: sql`${reconciliationRuns.claimToken} + 1`, nextAttemptAt: sql`now()`, finishedAt: null })
        .where(and(eq(reconciliationRuns.id, input.runId), eq(reconciliationRuns.status, "FAILED")))
        .returning(runColumns);
      if (!after) throw new Error(`reconciliation run ${input.runId} left FAILED while locked`);
      await recordAudit(tx, {
        actorUserId: input.userId,
        action: RUN_RETRY_ACTION,
        entityType: RUN_AUDIT_ENTITY,
        entityId: input.runId,
        previousState: { status: before.status, attempts: before.attempts, claimToken: before.claimToken },
        newState: { status: after.status, attempts: after.attempts, claimToken: before.claimToken + 1 },
        correlationId: input.correlationId,
      });
      return { outcome: "retried", run: after };
    });
  } catch (error) {
    if (!isUniqueViolation(error, ACTIVE_RUN_KEY)) throw error;
    result = { outcome: "already_active" };
  }
  countOutcome("reconciliation_requests_total", { outcome: result.outcome === "retried" ? "retried" : `retry_${result.outcome}` });
  return result;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const db = e as Error & { code?: unknown; constraint?: unknown };
    if (db.code === "23505" && db.constraint === constraint) return true;
  }
  return false;
}

export interface ClaimedRun {
  id: string;
  provider: string;
  window: ListWindow;
  /** Claims so far, including this one. */
  attempts: number;
  /** Fencing token of this claim. */
  claimToken: number;
  correlationId: string;
}

/**
 * Atomically claims the oldest due run for one of `providers`: PENDING, or RUNNING whose lease
 * expired (its worker died). Sets RUNNING, bumps attempts and claim_token, sets the lease.
 */
export async function claimNextRun(db: Db, { leaseSeconds, providers }: { leaseSeconds: number; providers: readonly string[] }): Promise<ClaimedRun | null> {
  if (providers.length === 0) return null;
  const { rows } = await db.execute<{
    id: string;
    provider: string;
    window_start: string;
    window_end: string;
    attempts: number;
    claim_token: number;
    correlation_id: string;
  }>(sql`
    UPDATE ${reconciliationRuns}
    SET status = 'RUNNING',
        attempts = attempts + 1,
        claim_token = claim_token + 1,
        next_attempt_at = now() + make_interval(secs => ${leaseSeconds})
    WHERE id = (
      SELECT id FROM ${reconciliationRuns}
      WHERE status IN ('PENDING', 'RUNNING') AND next_attempt_at <= now()
        AND provider IN (${sql.join(providers.map((p) => sql`${p}`), sql`, `)})
      ORDER BY next_attempt_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, provider, window_start, window_end, attempts, claim_token, correlation_id
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    window: { start: new Date(row.window_start), end: new Date(row.window_end) },
    attempts: row.attempts,
    claimToken: row.claim_token,
    correlationId: row.correlation_id,
  };
}

export type RunOutcome = "succeeded" | "failed" | "lease_lost";

class LeaseLostError extends Error {}

class FetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`provider fetch timed out after ${ms} ms`);
    this.name = "FetchTimeoutError";
  }
}

const claimed = (run: ClaimedRun) =>
  and(eq(reconciliationRuns.id, run.id), eq(reconciliationRuns.status, "RUNNING"), eq(reconciliationRuns.claimToken, run.claimToken));

interface FetchedRecords {
  payments: ListedPayment[];
  cardPayments: ListedCardPayment[];
  transfers: ListedTransfer[];
}

/** Our linked provider ids (set by `npm run increase:bootstrap`). Read with no transaction open. */
async function linkedProviderIds(db: Db): Promise<{ cardIds: string[]; accountIds: string[] }> {
  const cardRows = await db.select({ id: cards.providerId }).from(cards).where(isNotNull(cards.providerId));
  const accountRows = await db.select({ id: accounts.providerId }).from(accounts).where(isNotNull(accounts.providerId));
  return { cardIds: cardRows.map((r) => r.id!), accountIds: accountRows.map((r) => r.id!) };
}

const purchases = alias(transactions, "purchases");

/**
 * Provider objects our in-window transactions point at that a refund or return may postdate: the
 * purchase's card payment for a linked CARD_REVERSAL, the transfer for a PAYMENT_RETURN. Their
 * created_at can be days before the window, so the lists miss them. Read with no transaction open.
 */
async function parentIds(db: Db, provider: string, window: ListWindow): Promise<{ cardPaymentIds: string[]; transferIds: string[] }> {
  const inWindow = and(eq(transactions.provider, provider), sql`${transactions.createdAt} >= ${window.start} AND ${transactions.createdAt} < ${window.end}`);
  const reversals = await db
    .selectDistinct({ id: purchases.providerObjectId })
    .from(transactions)
    .innerJoin(purchases, eq(purchases.id, transactions.relatedTransactionId))
    .where(and(inWindow, eq(transactions.type, "CARD_REVERSAL"), isNotNull(purchases.providerObjectId)));
  const returns = await db
    .selectDistinct({ id: transactions.providerObjectId })
    .from(transactions)
    .where(and(inWindow, eq(transactions.type, "PAYMENT_RETURN"), isNotNull(transactions.providerObjectId)));
  return { cardPaymentIds: reversals.map((r) => r.id!), transferIds: returns.map((r) => r.id!) };
}

/**
 * Every list read the source has for `widened` (scoped to our cards and accounts), then a retrieve
 * of each parent our in-window refunds and returns point at that the lists didn't include. Logs
 * each page's or call's provider request id. A parent the provider doesn't have (4xx) is skipped:
 * its refund or return then reports MISSING_EXTERNAL.
 */
async function fetchRecords(
  db: Db,
  provider: string,
  source: ReconciliationSource,
  window: ListWindow,
  widened: ListWindow,
  signal: AbortSignal,
  log: Logger,
): Promise<FetchedRecords> {
  const fetched: FetchedRecords = { payments: [], cardPayments: [], transfers: [] };
  const logged = (list: string, result: { items: unknown[]; requestIds: Array<string | null> }) =>
    log.info({ outcome: "fetched", list, records: result.items.length, pages: result.requestIds.length, provider_request_ids: result.requestIds }, "fetched provider records");
  if (source.payments) {
    const result = await source.payments.listPayments(widened, signal);
    logged("payments", result);
    fetched.payments = result.items;
  }
  const scope = source.cards || source.transfers ? (source.scope ?? (await linkedProviderIds(db))) : { cardIds: [], accountIds: [] };
  if (source.cards) {
    for (const cardId of scope.cardIds) {
      const result = await source.cards.listCardPayments(widened, { cardId }, signal);
      logged("card_payments", result);
      fetched.cardPayments.push(...result.items);
    }
  }
  if (source.transfers) {
    for (const accountId of scope.accountIds) {
      const result = await source.transfers.listTransfers(widened, { accountId }, signal);
      logged("transfers", result);
      fetched.transfers.push(...result.items);
    }
  }

  if (!source.cards && !source.transfers) return fetched;
  const parents = await parentIds(db, provider, window);
  const listedCards = new Set(fetched.cardPayments.map((p) => p.id));
  const listedTransfers = new Set(fetched.transfers.map((t) => t.id));
  const missingCards = source.cards ? parents.cardPaymentIds.filter((id) => !listedCards.has(id)) : [];
  const missingTransfers = source.transfers ? parents.transferIds.filter((id) => !listedTransfers.has(id)) : [];
  if (missingCards.length + missingTransfers.length > MAX_PARENT_RETRIEVALS) {
    throw new Error(`${missingCards.length + missingTransfers.length} refund/return parents outside the listed window; at most ${MAX_PARENT_RETRIEVALS} per run`);
  }
  const retrieve = async <T extends { requestId: string | null }>(kind: string, id: string, read: () => Promise<T>): Promise<T | null> => {
    if (signal.aborted) throw new Error("provider fetch stopped: deadline passed");
    try {
      const item = await read();
      log.info({ outcome: "fetched", kind, provider_object_id: id, provider_request_id: item.requestId }, "retrieved parent outside the window");
      return item;
    } catch (error) {
      if (!(error instanceof ProviderRejectedError)) throw error;
      log.warn({ outcome: "parent_not_found", kind, provider_object_id: id, provider_request_id: error.requestId }, "provider has no parent for our refund or return");
      return null;
    }
  };
  for (const id of missingCards) {
    const payment = await retrieve("card_payment", id, () => source.cards!.retrieveCardPayment(id));
    if (payment) fetched.cardPayments.push(payment);
  }
  for (const id of missingTransfers) {
    const transfer = await retrieve("transfer", id, () => source.transfers!.retrieveTransfer(id));
    if (transfer) fetched.transfers.push(transfer);
  }
  return fetched;
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one claimed run: fetch the provider's records (no transaction open, one overall deadline),
 * then in one transaction that still owns the claim: load our side, classify, insert every record,
 * mark SUCCEEDED with the counts. Any failure marks it FAILED with a sanitized error.
 */
export async function executeRun(
  db: Db,
  run: ClaimedRun,
  sources: ReconciliationSources,
  logger: Logger,
  { fetchTimeoutMs = RUN_FETCH_TIMEOUT_MS, graceMs = RECONCILIATION_GRACE_MS, now = () => new Date() }: { fetchTimeoutMs?: number; graceMs?: number; now?: () => Date } = {},
): Promise<RunOutcome> {
  const log = logger.child({ run_id: run.id, correlation_id: run.correlationId, provider: run.provider, attempt: run.attempts });
  if (run.attempts > MAX_RUN_ATTEMPTS) return failRun(db, run, log, `gave up after ${MAX_RUN_ATTEMPTS} attempts; the last ones did not finish (worker crash or lease expiry)`);
  const source = sources[run.provider];
  if (!source) return failRun(db, run, log, `no reconciliation source for provider ${run.provider}`);

  let fetched: FetchedRecords;
  try {
    const widened = { start: new Date(run.window.start.getTime() - FETCH_MARGIN_MS), end: new Date(run.window.end.getTime() + FETCH_MARGIN_MS) };
    fetched = await withDeadline((signal) => fetchRecords(db, run.provider, source, run.window, widened, signal, log), fetchTimeoutMs);
  } catch (error) {
    return failRun(db, run, log, safeErrorMessage(error), error);
  }

  try {
    const counts = await countAfterCommit(() =>
      withTransaction(db, async (tx) => {
        const [row] = await tx.select({ id: reconciliationRuns.id }).from(reconciliationRuns).where(claimed(run)).for("update");
        if (!row) throw new LeaseLostError();
        const externals = await externalRecords(tx, run.provider, fetched, log);
        const internals = await internalRecords(tx, run.provider, run.window, externals);
        const results = classify(internals, externals, { window: run.window, asOf: now(), graceMs });
        const rows = results.map((r) => ({
          runId: run.id,
          status: r.status,
          reason: r.reason,
          transactionType: r.type,
          transactionId: r.internal?.transactionId ?? null,
          accountId: r.internal?.accountId ?? null,
          externalId: r.external?.id ?? null,
          externalRef: r.external?.ref ?? null,
          internalAmountCents: r.internal?.amountCents ?? null,
          externalAmountCents: r.external?.amountCents ?? null,
          internalStatus: r.internal?.status ?? null,
          externalStatus: r.external?.status ?? null,
        }));
        for (let i = 0; i < rows.length; i += INSERT_BATCH) await tx.insert(reconciliationRecords).values(rows.slice(i, i + INSERT_BATCH));
        const byStatus = countByStatus(results);
        await tx
          .update(reconciliationRuns)
          .set({ status: "SUCCEEDED", matchedCount: byStatus.MATCHED, exceptionCount: results.length - byStatus.MATCHED, lastError: null, finishedAt: sql`now()` })
          .where(eq(reconciliationRuns.id, run.id));
        for (const [status, count] of Object.entries(byStatus)) {
          if (count) countOutcome("reconciliation_results_total", { provider: run.provider, status }, count);
        }
        return byStatus;
      }),
    );
    countOutcome("reconciliation_runs_total", { provider: run.provider, outcome: "succeeded" });
    log.info({ outcome: "succeeded", ...counts }, "reconciliation run finished");
    return "succeeded";
  } catch (error) {
    if (error instanceof LeaseLostError) {
      countOutcome("reconciliation_runs_total", { provider: run.provider, outcome: "lease_lost" });
      log.warn({ outcome: "lease_lost" }, "reconciliation run claim lost to another worker; skipped");
      return "lease_lost";
    }
    return failRun(db, run, log, safeErrorMessage(error), error);
  }
}

async function failRun(db: Db, run: ClaimedRun, log: Logger, message: string, error?: unknown): Promise<RunOutcome> {
  const updated = await db
    .update(reconciliationRuns)
    .set({ status: "FAILED", lastError: message.slice(0, MAX_ERROR_LENGTH), finishedAt: sql`now()` })
    .where(claimed(run))
    .returning({ id: reconciliationRuns.id });
  const err = error === undefined ? undefined : safeErrorForLog(error);
  const outcome = updated.length ? "failed" : "lease_lost";
  countOutcome("reconciliation_runs_total", { provider: run.provider, outcome });
  log.error({ outcome, err, error_message: message }, outcome === "failed" ? "reconciliation run failed" : "reconciliation run failed after its claim was lost");
  return outcome;
}

/**
 * The provider's records in our vocabulary; ACH transfers name their payment's transaction through
 * our idempotency key. PaymentIntents without a valid `transaction_id` metadata aren't ours (we set it
 * on every one we create): they are dropped and only counted.
 */
async function externalRecords(tx: Tx, provider: string, fetched: FetchedRecords, log: Logger): Promise<ExternalRecord[]> {
  const paymentIdByTransfer = new Map<string, string>();
  for (const t of fetched.transfers) {
    const id = z.uuid().safeParse(PAYMENT_KEY.exec(t.idempotencyKey ?? "")?.[1]);
    if (id.success) paymentIdByTransfer.set(t.id, id.data);
  }
  const paymentIds = [...new Set(paymentIdByTransfer.values())];
  const linked = paymentIds.length
    ? await tx
        .select({ id: payments.id, transactionId: payments.transactionId })
        .from(payments)
        .where(and(inArray(payments.id, paymentIds), eq(payments.provider, provider)))
    : [];
  const transactionByPayment = new Map(linked.map((p) => [p.id, p.transactionId]));

  const ours = fetched.payments.filter((p) => z.uuid().safeParse(p.metadata.transactionId).success);
  const foreign = fetched.payments.length - ours.length;
  if (foreign) {
    countOutcome("reconciliation_foreign_records_total", { provider }, foreign);
    log.info({ outcome: "foreign_records", records: foreign }, "provider records without our metadata skipped");
  }

  return [
    ...ours.map((p) => fundingRecord(p)),
    ...fetched.cardPayments.flatMap((p) => cardPaymentRecords(p)),
    ...fetched.transfers.flatMap((t) => transferRecords(t, transactionByPayment.get(paymentIdByTransfer.get(t.id) ?? "") ?? null)),
  ];
}

/**
 * Our side: the provider's transactions created in the window, plus any the provider records
 * point at (so a pair split across the window edge still pairs), with their trace provider_refs
 * and posted amount (own ledger entry plus linked ADJUSTMENTs).
 */
async function internalRecords(tx: Tx, provider: string, window: ListWindow, externals: ExternalRecord[]): Promise<InternalRecord[]> {
  const objectIds = [...new Set(externals.map((e) => e.id))];
  const namedIds = [...new Set(externals.map((e) => e.transactionId).filter((id): id is string => id !== null))];
  const scope: SQL[] = [sql`${transactions.createdAt} >= ${window.start} AND ${transactions.createdAt} < ${window.end}`];
  if (objectIds.length) scope.push(inArray(transactions.providerObjectId, objectIds));
  if (namedIds.length) scope.push(inArray(transactions.id, namedIds));
  const rows = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      type: transactions.type,
      status: transactions.status,
      amountCents: transactions.amountCents,
      providerObjectId: transactions.providerObjectId,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .where(and(eq(transactions.provider, provider), ne(transactions.type, "ADJUSTMENT"), or(...scope)));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const refs = await tx
    .selectDistinct({ transactionId: transactionEvents.transactionId, ref: transactionEvents.providerRef })
    .from(transactionEvents)
    .where(and(inArray(transactionEvents.transactionId, ids), isNotNull(transactionEvents.providerRef)));
  const posted = await tx
    .select({ transactionId: ledgerEntries.transactionId, cents: sql<number>`sum(${ledgerEntries.amountCents})`.mapWith(Number) })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.transactionId, ids))
    .groupBy(ledgerEntries.transactionId);
  const adjusted = await tx
    .select({ transactionId: transactions.relatedTransactionId, cents: sql<number>`sum(${ledgerEntries.amountCents})`.mapWith(Number) })
    .from(transactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, transactions.id))
    .where(and(eq(transactions.type, "ADJUSTMENT"), inArray(transactions.relatedTransactionId, ids)))
    .groupBy(transactions.relatedTransactionId);

  const refsOf = new Map<string, string[]>();
  for (const r of refs) if (r.ref) refsOf.set(r.transactionId, [...(refsOf.get(r.transactionId) ?? []), r.ref]);
  const postedOf = new Map(posted.map((p) => [p.transactionId, p.cents]));
  const adjustedOf = new Map(adjusted.map((a) => [a.transactionId, a.cents]));
  return rows.map((r) => {
    const own = postedOf.get(r.id);
    return {
      transactionId: r.id,
      accountId: r.accountId,
      type: r.type as ReconciledType,
      status: r.status,
      amountCents: internalAmountCents(r.amountCents, own === undefined ? null : own + (adjustedOf.get(r.id) ?? 0)),
      providerObjectId: r.providerObjectId,
      providerRefs: refsOf.get(r.id) ?? [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}
