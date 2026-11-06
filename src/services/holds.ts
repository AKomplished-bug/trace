import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { holds } from "../db/schema";
import { nextHoldStatus, type HoldEvent, type HoldStatus } from "../domain/ledger";
import { lockAccount } from "./accounts";
import { appendTraceEvent } from "./trace";

export type Hold = typeof holds.$inferSelect;

/** Reads and row-locks a transaction's hold. Call with the account already locked. */
export async function lockHold(tx: Tx, accountId: string, transactionId: string): Promise<Hold> {
  const [hold] = await tx
    .select()
    .from(holds)
    .where(and(eq(holds.transactionId, transactionId), eq(holds.accountId, accountId)))
    .for("no key update");
  if (!hold) throw new Error(`No hold for transaction ${transactionId} on account ${accountId}`);
  return hold;
}

/**
 * State change only, no trace row: moves a locked hold to its next status, conditional on the
 * status it was read with. Throws IllegalHoldTransitionError if the hold is no longer ACTIVE.
 */
export async function setHoldStatus(tx: Tx, hold: Hold, event: HoldEvent): Promise<HoldStatus> {
  const to = nextHoldStatus(hold.status, event);
  const [updated] = await tx
    .update(holds)
    .set({ status: to, releasedAt: sql`now()` })
    .where(and(eq(holds.id, hold.id), eq(holds.status, hold.status)))
    .returning({ id: holds.id });
  if (!updated) throw new Error(`Hold ${hold.id} changed concurrently; expected ${hold.status}`);
  return to;
}

export interface TransitionHoldInput {
  accountId: string;
  /** The transaction that owns the hold (holds are UNIQUE per transaction). */
  transactionId: string;
  event: HoldEvent;
  externalEventId?: string | null;
  providerRef?: string | null;
}

/**
 * Releases or expires a transaction's hold on its own (no ledger effect, e.g. expiry) and
 * appends HOLD_RELEASED / HOLD_EXPIRED. Settlement goes through postLedgerEntry instead.
 */
export async function transitionHold(tx: Tx, input: TransitionHoldInput): Promise<{ holdId: string; status: HoldStatus }> {
  await lockAccount(tx, input.accountId);
  const hold = await lockHold(tx, input.accountId, input.transactionId);
  const to = await setHoldStatus(tx, hold, input.event);
  await appendTraceEvent(tx, {
    accountId: input.accountId,
    transactionId: input.transactionId,
    kind: to === "EXPIRED" ? "HOLD_EXPIRED" : "HOLD_RELEASED",
    amountCents: hold.amountCents,
    fromStatus: hold.status,
    toStatus: to,
    externalEventId: input.externalEventId,
    providerRef: input.providerRef,
  });
  return { holdId: hold.id, status: to };
}
