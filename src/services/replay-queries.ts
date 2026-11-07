import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { accounts, holds, ledgerEntries, payments, transactionEvents, transactions } from "../db/schema";
import { accountMismatches, moneyGraph, replayAccount, replayTransaction, type Balances, type Divergence, type ReplayEvent } from "../domain/replay";
import { logger as rootLogger, type Logger } from "../lib/logger";
import { READ_SNAPSHOT, readBalance } from "./account-queries";
import { countOutcome } from "./metrics";
import { readDetail, readTimeline, type TimelineStep, type TransactionDetail } from "./transaction-queries";

/**
 * Read-only replay (spec §11, §26): re-runs recorded trace rows through the domain's `apply`
 * and compares the result with the balances they recorded. Nothing here writes or locks.
 */

const ZERO: Balances = { ledgerCents: 0, availableCents: 0 };

/**
 * The one place a replay mismatch is reported, whoever read it (API, transaction page, /balance):
 * logged and counted in `replay_mismatch_total{scope}`. Matches are neither.
 */
function reportReplayMismatch(
  log: Logger,
  scope: "transaction" | "account",
  fields: { accountId: string; transactionId: string | null; divergence: Divergence | null; mismatches?: string[] },
) {
  const { divergence } = fields;
  countOutcome("replay_mismatch_total", { scope });
  log.warn(
    {
      outcome: "replay_mismatch",
      scope,
      account_id: fields.accountId,
      transaction_id: fields.transactionId ?? undefined,
      trace_event_id: divergence?.eventId,
      account_seq: divergence?.accountSeq,
      step: divergence ? divergence.stepIndex + 1 : undefined,
      reason: divergence?.reason,
      mismatches: fields.mismatches?.length ? fields.mismatches : undefined,
    },
    "replay does not match the recorded trace",
  );
}

/** Balances recorded by the account's trace rows at these account_seq values (unique index lookups). */
async function recordedAt(tx: Tx, accountId: string, accountSeqs: number[]): Promise<Map<number, Balances>> {
  if (accountSeqs.length === 0) return new Map();
  const rows = await tx
    .select({
      accountSeq: transactionEvents.accountSeq,
      ledgerCents: transactionEvents.ledgerBalanceAfterCents,
      availableCents: transactionEvents.availableAfterCents,
    })
    .from(transactionEvents)
    .where(and(eq(transactionEvents.accountId, accountId), inArray(transactionEvents.accountSeq, accountSeqs)));
  return new Map(rows.map((row) => [row.accountSeq, { ledgerCents: row.ledgerCents, availableCents: row.availableCents }]));
}

async function readReplay(tx: Tx, accountId: string, detail: TransactionDetail, steps: TimelineStep[]) {
  const previous = await recordedAt(
    tx,
    accountId,
    steps.map((step) => step.accountSeq - 1).filter((seq) => seq > 0),
  );
  const hold = detail.holds[0];
  const entryCents = new Map(detail.ledgerEntries.map((entry) => [entry.id, entry.amountCents]));
  const events: ReplayEvent[] = steps.map((step) => ({
    id: step.id,
    transactionId: detail.transaction.id,
    accountSeq: step.accountSeq,
    kind: step.kind,
    amountCents: step.amountCents,
    ledgerDeltaCents: step.ledgerDeltaCents,
    toStatus: step.toStatus,
    hold: hold ? { id: hold.id, kind: hold.kind } : null,
    recorded: { ledgerCents: step.ledgerBalanceAfterCents, availableCents: step.availableAfterCents },
    // The first row on the account starts from zero; otherwise the previous row is always there
    // (account_seq has no gaps), so a missing one is a broken trace and fails the check below.
    recordedBefore: step.accountSeq === 1 ? ZERO : (previous.get(step.accountSeq - 1) ?? ZERO),
    // A posting must agree with the ledger entry it points at (null: it points at none of ours).
    ledgerEntryCents: step.kind === "LEDGER_POSTED" ? (entryCents.get(step.ledgerEntryId ?? "") ?? null) : undefined,
  }));
  const result = replayTransaction(events);
  const graph = moneyGraph({
    transaction: { id: detail.transaction.id, type: detail.transaction.type, provider: detail.transaction.provider },
    steps: steps.map((step) => ({
      id: step.id,
      accountSeq: step.accountSeq,
      kind: step.kind,
      providerRef: step.providerRef,
      eventId: step.eventId,
      ledgerEntryId: step.ledgerEntryId,
      recorded: { ledgerCents: step.ledgerBalanceAfterCents, availableCents: step.availableAfterCents },
    })),
    ledgerEntries: detail.ledgerEntries,
    holds: detail.holds,
    externalEvents: detail.external.events,
    related: detail.related,
  });
  return {
    transactionId: detail.transaction.id,
    consistent: result.consistent,
    divergence: result.divergence,
    initial: result.initial,
    final: result.final,
    steps: result.steps.map((step, i) => ({
      event: steps[i],
      explanation: step.explanation,
      before: step.before,
      after: step.after,
      otherActivity: step.otherActivity,
      matches: step.matches,
    })),
    graph,
  };
}

export type TransactionReplay = Awaited<ReturnType<typeof readReplay>>;
export type ReplayStepView = TransactionReplay["steps"][number];

/** GET /api/transactions/:id/replay: the replay and money graph, from one snapshot. Null unless the transaction is on `accountId`. */
export async function getTransactionReplay(db: Db, accountId: string, transactionId: string, log: Logger = rootLogger): Promise<TransactionReplay | null> {
  return db.transaction(async (tx) => (await readTransactionWithReplay(tx, accountId, transactionId, log))?.replay ?? null, READ_SNAPSHOT);
}

/** Detail, money trace and replay from one snapshot, so the header, timeline and replay always agree. */
export async function getTransactionWithReplay(db: Db, accountId: string, transactionId: string, log: Logger = rootLogger) {
  return db.transaction((tx) => readTransactionWithReplay(tx, accountId, transactionId, log), READ_SNAPSHOT);
}

async function readTransactionWithReplay(tx: Tx, accountId: string, transactionId: string, log: Logger) {
  const detail = await readDetail(tx, accountId, transactionId);
  if (!detail) return null;
  const steps = await readTimeline(tx, accountId, transactionId);
  if (!steps) return null;
  const replay = await readReplay(tx, accountId, detail, steps);
  if (!replay.consistent) reportReplayMismatch(log, "transaction", { accountId, transactionId, divergence: replay.divergence });
  return { detail, steps, replay };
}

/**
 * Every trace row on the account, replayed from zero in account_seq order, checked against the
 * cached balance, SUM(ledger_entries), available and the active holds. Reads the whole trace
 * (an ordered scan of transaction_events_account_seq_key), which is fine at sandbox volume.
 */
async function readAccountReplay(tx: Tx, accountId: string, log: Logger) {
  const rows = await tx
    .select({
      id: transactionEvents.id,
      transactionId: transactionEvents.transactionId,
      accountSeq: transactionEvents.accountSeq,
      kind: transactionEvents.kind,
      amountCents: transactionEvents.amountCents,
      ledgerDeltaCents: transactionEvents.ledgerDeltaCents,
      toStatus: transactionEvents.toStatus,
      ledgerCents: transactionEvents.ledgerBalanceAfterCents,
      availableCents: transactionEvents.availableAfterCents,
      holdId: holds.id,
      holdKind: holds.kind,
    })
    .from(transactionEvents)
    .leftJoin(holds, eq(holds.transactionId, transactionEvents.transactionId))
    .where(eq(transactionEvents.accountId, accountId))
    .orderBy(asc(transactionEvents.accountSeq));
  const result = replayAccount(
    rows.map((row) => ({
      id: row.id,
      transactionId: row.transactionId,
      accountSeq: row.accountSeq,
      kind: row.kind,
      amountCents: row.amountCents,
      ledgerDeltaCents: row.ledgerDeltaCents,
      toStatus: row.toStatus,
      hold: row.holdId && row.holdKind ? { id: row.holdId, kind: row.holdKind } : null,
      recorded: { ledgerCents: row.ledgerCents, availableCents: row.availableCents },
    })),
  );

  const [account] = await tx.select({ ledgerBalanceCents: accounts.ledgerBalanceCents }).from(accounts).where(eq(accounts.id, accountId));
  if (!account) return null;
  const [sum] = await tx
    .select({ cents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`.mapWith(Number) })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  const active = await tx
    .select({ id: holds.id, amountCents: holds.amountCents })
    .from(holds)
    .where(and(eq(holds.accountId, accountId), eq(holds.status, "ACTIVE")));
  const mismatches = accountMismatches(result, {
    cachedLedgerCents: account.ledgerBalanceCents,
    ledgerSumCents: sum.cents,
    activeHoldIds: active.map((hold) => hold.id),
    availableCents: account.ledgerBalanceCents - active.reduce((total, hold) => total + hold.amountCents, 0),
  });
  const matchesStored = result.consistent && mismatches.length === 0;
  if (!matchesStored) reportReplayMismatch(log, "account", { accountId, transactionId: null, divergence: result.divergence, mismatches });
  return {
    stepCount: result.steps.length,
    consistent: result.consistent,
    divergence: result.divergence,
    final: { ledgerCents: result.final.ledgerCents, availableCents: result.final.availableCents },
    /** Replay agrees with every row and with the stored balances and holds. */
    matchesStored,
    mismatches,
  };
}

export type AccountReplay = NonNullable<Awaited<ReturnType<typeof readAccountReplay>>>;

export async function getAccountReplay(db: Db, accountId: string, log: Logger = rootLogger): Promise<AccountReplay | null> {
  return db.transaction((tx) => readAccountReplay(tx, accountId, log), READ_SNAPSHOT);
}

/**
 * The /balance page: the balance decomposition, the active holds that make up "pending" (each
 * with its transaction), and the account replay that re-derives the balance — one snapshot.
 */
export async function getBalanceExplanation(db: Db, accountId: string, log: Logger = rootLogger) {
  return db.transaction(async (tx) => {
    const balance = await readBalance(tx, accountId);
    if (!balance) return null;
    const activeHolds = await tx
      .select({
        id: holds.id,
        kind: holds.kind,
        amountCents: holds.amountCents,
        createdAt: holds.createdAt,
        expiresAt: holds.expiresAt,
        transactionId: transactions.id,
        type: transactions.type,
        status: transactions.status,
        provider: transactions.provider,
        counterparty: transactions.counterparty,
        recipient: payments.recipient,
      })
      .from(holds)
      .innerJoin(transactions, eq(transactions.id, holds.transactionId))
      .leftJoin(payments, eq(payments.transactionId, holds.transactionId))
      .where(and(eq(holds.accountId, accountId), eq(holds.status, "ACTIVE")))
      .orderBy(asc(holds.createdAt), asc(holds.id));
    const replay = await readAccountReplay(tx, accountId, log);
    return replay ? { balance, activeHolds, replay } : null;
  }, READ_SNAPSHOT);
}

export type BalanceExplanationView = NonNullable<Awaited<ReturnType<typeof getBalanceExplanation>>>;
