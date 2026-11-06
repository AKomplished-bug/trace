import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/client";
import { holds, ledgerEntries, transactionEvents } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { InvalidLedgerEntryError } from "../domain/ledger";
import { transitionHold } from "./holds";
import { LedgerConflictError, postLedgerEntry, type PostLedgerEntryInput } from "./ledger";
import { appendTraceEvent } from "./trace";

const { pool, db } = createTestDb(20);

function post(input: Omit<PostLedgerEntryInput, "accountId">) {
  return withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, ...input }));
}

async function expectInvariant() {
  const { cachedCents, ledgerSumCents } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  return cachedCents;
}

/** An $80 card authorization: ACTIVE hold plus its HOLD_CREATED trace step. */
async function authorize(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents });
  await withTransaction(db, async (tx) => {
    await tx.insert(holds).values({ transactionId, accountId: SEED.accountId, kind: "CARD_AUTHORIZATION", amountCents });
    await appendTraceEvent(tx, { accountId: SEED.accountId, transactionId, kind: "HOLD_CREATED", amountCents });
  });
  return transactionId;
}

async function trace(transactionId?: string) {
  return db
    .select()
    .from(transactionEvents)
    .where(transactionId ? eq(transactionEvents.transactionId, transactionId) : undefined)
    .orderBy(asc(transactionEvents.accountSeq));
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe("postLedgerEntry", () => {
  it("fund $500 → authorize $80 → settle $65 → reverse: balances, cache and trace", async () => {
    const funding = await createTransaction(db, { type: "FUNDING", amountCents: 50000 });
    expect(await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 })).toMatchObject({
      posted: true,
      ledgerBalanceCents: 50000,
      availableCents: 50000,
    });
    expect(await expectInvariant()).toBe(50000);

    const purchase = await authorize(8000);
    const settled = await post({
      transactionId: purchase,
      entryType: "CARD_SETTLEMENT_DEBIT",
      amountCents: -6500,
      providerRef: "card_settlement_1",
      releaseHoldForTransactionId: purchase,
    });
    expect(settled).toMatchObject({ posted: true, ledgerBalanceCents: 43500, availableCents: 43500 });
    expect(await expectInvariant()).toBe(43500);
    expect((await db.select().from(holds).where(eq(holds.transactionId, purchase)))[0].status).toBe("RELEASED");

    const reversal = await createTransaction(db, {
      type: "CARD_REVERSAL",
      amountCents: 6500,
      relatedTransactionId: purchase,
      provider: "increase",
      providerObjectId: "card_refund_1",
    });
    expect(await post({ transactionId: reversal, entryType: "CARD_REVERSAL_CREDIT", amountCents: 6500 })).toMatchObject({
      posted: true,
      ledgerBalanceCents: 50000,
      availableCents: 50000,
    });
    expect(await expectInvariant()).toBe(50000);

    const steps = await trace();
    expect(
      steps.map((e) => [e.accountSeq, e.transactionId, e.seq, e.kind, e.ledgerDeltaCents, e.ledgerBalanceAfterCents, e.availableAfterCents]),
    ).toEqual([
      [1, funding, 1, "LEDGER_POSTED", 50000, 50000, 50000],
      [2, purchase, 1, "HOLD_CREATED", 0, 50000, 42000],
      [3, purchase, 2, "LEDGER_POSTED", -6500, 43500, 43500],
      [4, purchase, 3, "HOLD_RELEASED", 0, 43500, 43500],
      [5, reversal, 1, "LEDGER_POSTED", 6500, 50000, 50000],
    ]);
    // Available only ever reads values that were true outside a transaction: 500, 420, 435, 500.
    expect(steps.map((e) => e.availableAfterCents)).toEqual([50000, 42000, 43500, 43500, 50000]);
    let running = 0;
    for (const step of steps) {
      running += step.ledgerDeltaCents;
      expect(step.ledgerBalanceAfterCents).toBe(running);
    }
    expect(steps.filter((e) => e.transactionId === purchase && e.kind !== "HOLD_CREATED").map((e) => e.providerRef)).toEqual([
      "card_settlement_1",
      "card_settlement_1",
    ]);
  });

  it("posts the same (transaction_id, entry_type, amount) once, even when sent twice or racing", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    const input = { transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 } as const;

    const results = await Promise.all(Array.from({ length: 10 }, () => post(input)));
    expect(results.filter((r) => r.posted)).toHaveLength(1);
    expect(await post(input)).toEqual({ posted: false, ledgerBalanceCents: 50000, availableCents: 50000 });

    expect(await db.select().from(ledgerEntries)).toHaveLength(1);
    expect(await trace()).toHaveLength(1);
    expect(await expectInvariant()).toBe(50000);
  });

  it("a duplicate settlement neither posts again nor re-releases the hold", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 });
    const purchase = await authorize(8000);
    const settle = {
      transactionId: purchase,
      entryType: "CARD_SETTLEMENT_DEBIT",
      amountCents: -6500,
      releaseHoldForTransactionId: purchase,
    } as const;
    await post(settle);
    expect(await post(settle)).toEqual({ posted: false, ledgerBalanceCents: 43500, availableCents: 43500 });
    expect(await trace(purchase)).toHaveLength(3);
    expect(await expectInvariant()).toBe(43500);
  });

  it("throws LedgerConflictError when the same effect arrives with a different amount", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 });
    await expect(post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 40000 })).rejects.toThrow(
      LedgerConflictError,
    );
    expect(await db.select().from(ledgerEntries)).toHaveLength(1);
    expect(await expectInvariant()).toBe(50000);
  });

  it("posts a settlement that arrives after its hold expired (late capture) and records it", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 });
    const purchase = await authorize(8000);
    await withTransaction(db, (tx) =>
      transitionHold(tx, { accountId: SEED.accountId, transactionId: purchase, event: "EXPIRE" }),
    );

    const settled = await post({
      transactionId: purchase,
      entryType: "CARD_SETTLEMENT_DEBIT",
      amountCents: -6500,
      releaseHoldForTransactionId: purchase,
    });
    expect(settled).toMatchObject({ posted: true, ledgerBalanceCents: 43500, availableCents: 43500 });
    expect(await expectInvariant()).toBe(43500);
    expect((await db.select().from(holds).where(eq(holds.transactionId, purchase)))[0].status).toBe("EXPIRED");

    const steps = await trace(purchase);
    expect(steps.map((e) => [e.seq, e.kind, e.fromStatus, e.toStatus, e.ledgerDeltaCents, e.ledgerBalanceAfterCents, e.availableAfterCents])).toEqual([
      [1, "HOLD_CREATED", null, null, 0, 50000, 42000],
      [2, "HOLD_EXPIRED", "ACTIVE", "EXPIRED", 0, 50000, 50000],
      [3, "LEDGER_POSTED", null, null, -6500, 43500, 43500],
      [4, "SETTLED_AFTER_HOLD_CLOSED", "EXPIRED", "EXPIRED", 0, 43500, 43500],
    ]);
  });

  it("rolls back when the settlement has no hold to release", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 });
    const purchase = await createTransaction(db, { type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents: 8000 });
    await expect(
      post({ transactionId: purchase, entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500, releaseHoldForTransactionId: purchase }),
    ).rejects.toThrow("No hold for transaction");
    expect(await db.select().from(ledgerEntries)).toHaveLength(1);
    expect(await expectInvariant()).toBe(50000);
  });

  it("allows several partial reversals of one purchase, each keyed by its own provider element", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 });
    const purchase = await authorize(8000);
    await post({ transactionId: purchase, entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500, releaseHoldForTransactionId: purchase });

    const reversal = (elementId: string, amountCents: number) =>
      createTransaction(db, {
        type: "CARD_REVERSAL",
        amountCents,
        relatedTransactionId: purchase,
        provider: "increase",
        providerObjectId: elementId,
      });
    const first = await reversal("card_refund_a", 2000);
    const second = await reversal("card_refund_b", 1500);
    await post({ transactionId: first, entryType: "CARD_REVERSAL_CREDIT", amountCents: 2000, providerRef: "card_refund_a" });
    await post({ transactionId: second, entryType: "CARD_REVERSAL_CREDIT", amountCents: 1500, providerRef: "card_refund_b" });
    expect(await expectInvariant()).toBe(47000);

    // The same reversal element can't become a second transaction.
    await expect(reversal("card_refund_a", 2000)).rejects.toThrow();
  });

  it("only lets each transaction type post its own entry type", async () => {
    const funding = await createTransaction(db, { type: "FUNDING", amountCents: 50000 });
    await expect(post({ transactionId: funding, entryType: "ADJUSTMENT", amountCents: -1500 })).rejects.toThrow(
      InvalidLedgerEntryError,
    );
    // A correction is its own ADJUSTMENT transaction, linked to the original.
    const adjustment = await createTransaction(db, { type: "ADJUSTMENT", amountCents: 1500, relatedTransactionId: funding });
    expect((await post({ transactionId: adjustment, entryType: "ADJUSTMENT", amountCents: -1500 })).posted).toBe(true);
    expect(await expectInvariant()).toBe(-1500);
  });

  it("doesn't lose updates or reuse sequence numbers when many connections post to one account", async () => {
    const count = 50;
    const ids = await Promise.all(Array.from({ length: count }, (_, i) => createTransaction(db, { amountCents: 100 + i })));
    await Promise.all(ids.map((transactionId, i) => post({ transactionId, entryType: "FUNDING_CREDIT", amountCents: 100 + i })));
    const expected = Array.from({ length: count }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
    expect(await expectInvariant()).toBe(expected);

    const steps = await trace();
    expect(steps.map((e) => e.accountSeq)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    // Each step's balance is the previous step's balance plus its delta, in account_seq order.
    let running = 0;
    for (const step of steps) {
      running += step.ledgerDeltaCents;
      expect(step.ledgerBalanceAfterCents).toBe(running);
    }
  });

  it("rejects a transaction that belongs to another account", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await expect(
      withTransaction(db, (tx) =>
        postLedgerEntry(tx, {
          accountId: "00000000-0000-4000-8000-0000000000ff",
          transactionId: funding,
          entryType: "FUNDING_CREDIT",
          amountCents: 50000,
        }),
      ),
    ).rejects.toThrow("not found");
    expect(await expectInvariant()).toBe(0);
  });

  it("rejects an entry with the wrong sign and changes nothing", async () => {
    const funding = await createTransaction(db, { amountCents: 50000 });
    await expect(post({ transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: -50000 })).rejects.toThrow(
      InvalidLedgerEntryError,
    );
    expect(await db.select().from(ledgerEntries)).toHaveLength(0);
    expect(await expectInvariant()).toBe(0);
  });
});
