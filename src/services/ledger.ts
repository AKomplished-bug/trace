import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { accounts, ledgerEntries, transactions } from "../db/schema";
import { assertEntryTypeForTransaction, assertLedgerEntryAmount, type LedgerEntryType } from "../domain/ledger";
import { logger as rootLogger, type Logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "./accounts";
import { lockHold, setHoldStatus, type Hold } from "./holds";
import { appendTraceEvent } from "./trace";

export interface PostLedgerEntryInput {
  accountId: string;
  transactionId: string;
  entryType: LedgerEntryType;
  /** Signed integer cents: credit positive, debit negative. */
  amountCents: number;
  externalEventId?: string | null;
  providerRef?: string | null;
  /**
   * Settlement: release this transaction's hold in the same database transaction. All state
   * changes (entry, cached balance, hold status) happen before any trace row is written, so the
   * trace reads LEDGER_POSTED then HOLD_RELEASED, both with the final balances — never a
   * balance that wasn't true outside the transaction. If the hold already EXPIRED or was
   * RELEASED (late capture), the debit still posts and SETTLED_AFTER_HOLD_CLOSED records it.
   */
  releaseHoldForTransactionId?: string;
}

export type PostLedgerEntryResult =
  | { posted: true; ledgerEntryId: string; ledgerBalanceCents: number; availableCents: number }
  // The identical (transaction_id, entry_type, amount) effect already exists; nothing changed.
  | { posted: false; ledgerBalanceCents: number; availableCents: number };

/** The same (transaction_id, entry_type) was already posted with a different amount. */
export class LedgerConflictError extends Error {
  constructor(
    readonly transactionId: string,
    readonly entryType: LedgerEntryType,
    readonly postedCents: number,
    readonly attemptedCents: number,
  ) {
    super(`${entryType} for transaction ${transactionId} already posted as ${postedCents}, not ${attemptedCents}`);
    this.name = "LedgerConflictError";
  }
}

/**
 * Posts one ledger entry inside the caller's transaction: locks the account row, inserts the
 * entry (once per transaction_id + entry_type), optionally releases a hold, updates the cached
 * ledger balance and appends LEDGER_POSTED to the trace.
 */
export async function postLedgerEntry(
  tx: Tx,
  input: PostLedgerEntryInput,
  logger: Logger = rootLogger,
): Promise<PostLedgerEntryResult> {
  const log = logger.child({
    account_id: input.accountId,
    transaction_id: input.transactionId,
    event_id: input.externalEventId ?? undefined,
    entry_type: input.entryType,
  });
  assertLedgerEntryAmount(input.entryType, input.amountCents);

  const account = await lockAccount(tx, input.accountId);
  const [transaction] = await tx
    .select({ type: transactions.type })
    .from(transactions)
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.accountId, input.accountId)));
  if (!transaction) throw new Error(`Transaction ${input.transactionId} not found on account ${input.accountId}`);
  assertEntryTypeForTransaction(transaction.type, input.entryType);
  // Read and lock the hold before posting, so nothing that can throw sits between the entry
  // insert and the balance update.
  const hold: Hold | undefined = input.releaseHoldForTransactionId
    ? await lockHold(tx, input.accountId, input.releaseHoldForTransactionId)
    : undefined;

  const [entry] = await tx
    .insert(ledgerEntries)
    .values({
      accountId: input.accountId,
      transactionId: input.transactionId,
      entryType: input.entryType,
      amountCents: input.amountCents,
      externalEventId: input.externalEventId ?? null,
    })
    .onConflictDoNothing({ target: [ledgerEntries.transactionId, ledgerEntries.entryType] })
    .returning({ id: ledgerEntries.id });

  if (!entry) {
    const [existing] = await tx
      .select({ amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.transactionId, input.transactionId), eq(ledgerEntries.entryType, input.entryType)));
    if (existing.amountCents !== input.amountCents) {
      log.warn({ outcome: "conflict", posted_cents: existing.amountCents, attempted_cents: input.amountCents }, "ledger entry conflicts with the posted one");
      throw new LedgerConflictError(input.transactionId, input.entryType, existing.amountCents, input.amountCents);
    }
    log.info({ outcome: "duplicate" }, "ledger entry already posted; no effect");
    return {
      posted: false,
      ledgerBalanceCents: account.ledgerBalanceCents,
      availableCents: await accountAvailableCents(tx, input.accountId, account.ledgerBalanceCents),
    };
  }

  await tx
    .update(accounts)
    .set({ ledgerBalanceCents: sql`${accounts.ledgerBalanceCents} + ${input.amountCents}`, updatedAt: sql`now()` })
    .where(eq(accounts.id, input.accountId));
  const released = hold?.status === "ACTIVE" ? await setHoldStatus(tx, hold, "RELEASE") : undefined;

  const trace = await appendTraceEvent(tx, {
    accountId: input.accountId,
    transactionId: input.transactionId,
    kind: "LEDGER_POSTED",
    amountCents: input.amountCents,
    ledgerDeltaCents: input.amountCents,
    externalEventId: input.externalEventId,
    ledgerEntryId: entry.id,
    providerRef: input.providerRef,
  });

  if (hold) {
    await appendTraceEvent(tx, {
      accountId: input.accountId,
      transactionId: hold.transactionId,
      kind: released ? "HOLD_RELEASED" : "SETTLED_AFTER_HOLD_CLOSED",
      amountCents: hold.amountCents,
      fromStatus: hold.status,
      toStatus: released ?? hold.status,
      externalEventId: input.externalEventId,
      providerRef: input.providerRef,
    });
    if (!released) log.warn({ outcome: "settled_after_hold_closed", hold_status: hold.status }, "settlement posted after its hold had closed");
  }

  log.info(
    { outcome: "posted", ledger_entry_id: entry.id, amount_cents: input.amountCents, ledger_balance_cents: trace.ledgerBalanceAfterCents },
    "ledger entry posted",
  );
  return {
    posted: true,
    ledgerEntryId: entry.id,
    ledgerBalanceCents: trace.ledgerBalanceAfterCents,
    availableCents: trace.availableAfterCents,
  };
}
