import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { accounts, holds } from "../db/schema";
import { availableCents } from "../domain/ledger";

/**
 * Locks the account row for the rest of the transaction and returns its cached ledger balance.
 * Every writer of an account's ledger, holds or trace takes this lock first (after the event
 * row, before transaction/hold/payment rows); it is what keeps the balance cache, available
 * balance and trace sequence numbers consistent. Re-locking in the same transaction is a no-op.
 * NO KEY UPDATE so inserts referencing the account (FK checks) aren't blocked.
 */
export async function lockAccount(tx: Tx, accountId: string): Promise<{ ledgerBalanceCents: number }> {
  const [account] = await tx
    .select({ ledgerBalanceCents: accounts.ledgerBalanceCents })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("no key update");
  if (!account) throw new Error(`Account ${accountId} not found`);
  return account;
}

/** Available = ledger − active holds, from the holds table. Call with the account locked. */
export async function accountAvailableCents(tx: Tx, accountId: string, ledgerBalanceCents: number): Promise<number> {
  const active = await tx
    .select({ kind: holds.kind, status: holds.status, amountCents: holds.amountCents })
    .from(holds)
    .where(and(eq(holds.accountId, accountId), eq(holds.status, "ACTIVE")));
  return availableCents(ledgerBalanceCents, active);
}
