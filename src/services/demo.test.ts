import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { holds, ledgerEntries, transactionEvents, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, resetDb } from "../db/test-helpers";
import { DEMO, seedDemoStory } from "./demo";

const { pool, db } = createTestDb();

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

async function snapshot() {
  return {
    transactions: await db.select({ id: transactions.id, status: transactions.status }).from(transactions).orderBy(asc(transactions.id)),
    entries: await db.select({ amountCents: ledgerEntries.amountCents }).from(ledgerEntries).orderBy(asc(ledgerEntries.amountCents)),
    holds: await db.select({ status: holds.status }).from(holds),
    trace: await db
      .select({ kind: transactionEvents.kind, to: transactionEvents.toStatus, ledger: transactionEvents.ledgerBalanceAfterCents, available: transactionEvents.availableAfterCents })
      .from(transactionEvents)
      .orderBy(asc(transactionEvents.accountSeq)),
  };
}

describe("seedDemoStory", () => {
  it("builds fund $500 → authorize $80 → settle $65, and re-running changes nothing", async () => {
    await seedDemoStory(db);
    const first = await snapshot();
    expect(first.transactions).toEqual([
      { id: DEMO.fundingTransactionId, status: "SETTLED" },
      { id: DEMO.purchaseTransactionId, status: "SETTLED" },
    ]);
    expect(first.holds).toEqual([{ status: "RELEASED" }]);
    expect(first.trace).toEqual([
      { kind: "STATUS_CHANGED", to: "PENDING", ledger: 0, available: 0 },
      { kind: "LEDGER_POSTED", to: null, ledger: 50000, available: 50000 },
      { kind: "STATUS_CHANGED", to: "SETTLED", ledger: 50000, available: 50000 },
      { kind: "HOLD_CREATED", to: null, ledger: 50000, available: 42000 },
      { kind: "LEDGER_POSTED", to: null, ledger: 43500, available: 43500 },
      { kind: "HOLD_RELEASED", to: "RELEASED", ledger: 43500, available: 43500 },
      { kind: "STATUS_CHANGED", to: "SETTLED", ledger: 43500, available: 43500 },
    ]);

    await seedDemoStory(db);
    expect(await snapshot()).toEqual(first);
    const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
    expect([cachedCents, ledgerSumCents]).toEqual([43500, 43500]);
    expect(replayMatches).toBe(true);
    expect((await db.select().from(holds).where(eq(holds.accountId, SEED.accountId)))[0].amountCents).toBe(8000);
  });

  it("refuses to run in production", async () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      await expect(seedDemoStory(db)).rejects.toThrow("refusing to run with NODE_ENV=production");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
    expect(await db.select().from(transactions)).toHaveLength(0);
  });
});
