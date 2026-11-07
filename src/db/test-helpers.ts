import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { createDb, createPool, type Db } from "./client";
import { getAccountReplay } from "../services/replay-queries";
import { seed, SEED, testPasswordHashes, type SeedPasswordHashes } from "./seed";
import { accounts, ledgerEntries, transactions } from "./schema";

/** Test-only database on DATABASE_URL_TEST (migrated by test-global-setup.ts). */
export function createTestDb(max = 10): { pool: pg.Pool; db: Db } {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is required for integration tests (see .env.example)");
  const pool = createPool(url, max);
  return { pool, db: createDb(pool) };
}

// Hashed once per test file: scrypt is deliberately slow.
let passwordHashes: Promise<SeedPasswordHashes> | undefined;

/** Empties every table and re-applies the demo seed, with TEST_PASSWORDS. */
export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((row) => `"${row.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
  await seed(db, await (passwordHashes ??= testPasswordHashes()));
}

export async function createTransaction(
  db: Db,
  values: Partial<typeof transactions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(transactions)
    .values({ accountId: SEED.accountId, type: "FUNDING", status: "PENDING", amountCents: 1, ...values })
    .returning({ id: transactions.id });
  return row.id;
}

/**
 * The money invariants: cached balance == SUM(ledger_entries) for the account, and replaying the
 * account's whole trace from zero matches every recorded row and the stored balances and holds
 * (`replayMatches`).
 */
export async function balances(db: Db, accountId: string = SEED.accountId) {
  const [cached] = await db
    .select({ cents: accounts.ledgerBalanceCents })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const [ledger] = await db
    .select({ cents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`.mapWith(Number) })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  const replay = await getAccountReplay(db, accountId);
  return { cachedCents: cached.cents, ledgerSumCents: ledger.cents, replayMatches: replay?.matchesStored ?? false };
}
