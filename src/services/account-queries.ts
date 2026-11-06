import { and, asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { accounts, businesses, cards, holds } from "../db/schema";
import { balanceExplanationLines, explainBalance } from "../domain/ledger";

/** One consistent snapshot for reads that span several tables (no locks taken). */
export const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

export async function getAccountSummary(db: Db, accountId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      businessId: accounts.businessId,
      businessName: businesses.name,
      currency: accounts.currency,
      status: accounts.status,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .innerJoin(businesses, eq(businesses.id, accounts.businessId))
    .where(eq(accounts.id, accountId));
  if (!account) return null;
  const accountCards = await db
    .select({ id: cards.id, last4: cards.last4, status: cards.status, createdAt: cards.createdAt })
    .from(cards)
    .where(eq(cards.accountId, accountId))
    .orderBy(asc(cards.createdAt));
  return { account, cards: accountCards };
}

export type AccountSummary = NonNullable<Awaited<ReturnType<typeof getAccountSummary>>>;

/**
 * Ledger balance, active holds by kind and available, from one snapshot so the numbers always
 * add up (a settlement commits its debit and hold release together).
 */
export async function getBalance(db: Db, accountId: string) {
  return db.transaction((tx) => readBalance(tx, accountId), READ_SNAPSHOT);
}

export async function readBalance(tx: Tx, accountId: string) {
  const [account] = await tx
    .select({ ledgerBalanceCents: accounts.ledgerBalanceCents, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) return null;
  const active = await tx
    .select({ kind: holds.kind, status: holds.status, amountCents: holds.amountCents })
    .from(holds)
    .where(and(eq(holds.accountId, accountId), eq(holds.status, "ACTIVE")));
  const explanation = explainBalance(account.ledgerBalanceCents, active);
  return { currency: account.currency, ...explanation, explanation: balanceExplanationLines(explanation) };
}

export type Balance = NonNullable<Awaited<ReturnType<typeof readBalance>>>;
