import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { transactionEvents, transactions } from "../db/schema";
import { accountAvailableCents, lockAccount } from "./accounts";

export type TraceEvent = typeof transactionEvents.$inferSelect;

export interface TraceEventInput {
  accountId: string;
  transactionId: string;
  kind: TraceEvent["kind"];
  amountCents?: number | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  ledgerDeltaCents?: number;
  externalEventId?: string | null;
  ledgerEntryId?: string | null;
  /** Provider element behind this step (settlement, reversal or return id). */
  providerRef?: string | null;
}

/**
 * Appends one step to the money trace. The only writer of transaction_events. Apply the change
 * first, then call this in the same transaction: it locks the account, assigns `seq` (per
 * transaction) and `account_seq` (per account), and records the ledger and available balance
 * as they stand after the change.
 */
export async function appendTraceEvent(tx: Tx, input: TraceEventInput): Promise<TraceEvent> {
  const { ledgerBalanceCents } = await lockAccount(tx, input.accountId);
  const [owned] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.accountId, input.accountId)));
  if (!owned) throw new Error(`Transaction ${input.transactionId} not found on account ${input.accountId}`);

  const availableAfterCents = await accountAvailableCents(tx, input.accountId, ledgerBalanceCents);
  const [event] = await tx
    .insert(transactionEvents)
    .values({
      transactionId: input.transactionId,
      accountId: input.accountId,
      seq: sql`(SELECT coalesce(max(${transactionEvents.seq}), 0) + 1 FROM ${transactionEvents} WHERE ${transactionEvents.transactionId} = ${input.transactionId})`,
      accountSeq: sql`(SELECT coalesce(max(${transactionEvents.accountSeq}), 0) + 1 FROM ${transactionEvents} WHERE ${transactionEvents.accountId} = ${input.accountId})`,
      kind: input.kind,
      amountCents: input.amountCents ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      ledgerDeltaCents: input.ledgerDeltaCents ?? 0,
      ledgerBalanceAfterCents: ledgerBalanceCents,
      availableAfterCents,
      externalEventId: input.externalEventId ?? null,
      ledgerEntryId: input.ledgerEntryId ?? null,
      providerRef: input.providerRef ?? null,
    })
    .returning();
  return event;
}
