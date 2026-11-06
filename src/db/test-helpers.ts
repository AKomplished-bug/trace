import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { createDb, createPool, type Db } from "./client";
import { seed, SEED } from "./seed";
import { accounts, ledgerEntries, transactions } from "./schema";

/** Test-only database on DATABASE_URL_TEST (migrated by test-global-setup.ts). */
export function createTestDb(max = 10): { pool: pg.Pool; db: Db } {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is required for integration tests (see .env.example)");
  const pool = createPool(url, max);
  return { pool, db: createDb(pool) };
}

/** Empties every table and re-applies the demo seed. */
export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((row) => `"${row.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
  await seed(db);
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

/** The money invariant: cached balance == SUM(ledger_entries) for the account. */
export async function balances(db: Db, accountId: string = SEED.accountId) {
  const [cached] = await db
    .select({ cents: accounts.ledgerBalanceCents })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const [ledger] = await db
    .select({ cents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`.mapWith(Number) })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return { cachedCents: cached.cents, ledgerSumCents: ledger.cents };
}
