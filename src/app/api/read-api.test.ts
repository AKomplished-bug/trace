import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../db/client";
import { accounts, businesses, externalEvents, holds, transactions, users } from "../../db/schema";
import { SEED } from "../../db/seed";
import { createTestDb, createTransaction, resetDb } from "../../db/test-helpers";
import { BALANCE_FORMULA } from "../../domain/ledger";
import { sessionConfig } from "../../lib/config";
import { newId } from "../../lib/ids";
import { logger } from "../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../lib/session";
import { DEMO, seedDemoStory } from "../../services/demo";
import { postLedgerEntry } from "../../services/ledger";
import { appendTraceEvent } from "../../services/trace";
import { handleGetAccount, handleGetBalance } from "./account/handle-account";
import { handleGetTimeline, handleGetTransaction, handleListTransactions } from "./transactions/handle-transactions";

const { pool, db } = createTestDb();
const deps = { db, logger };
const OTHER = {
  businessId: "00000000-0000-4000-8000-0000000000b1",
  accountId: "00000000-0000-4000-8000-0000000000b2",
  ownerUserId: "00000000-0000-4000-8000-0000000000b3",
};

let cookie: string | undefined;
function signIn(userId: string, role: "OWNER" | "OPS" = "OWNER", accountId: string | null = role === "OWNER" ? SEED.accountId : null) {
  const token = signSession({ userId, role, accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET);
  cookie = `${SESSION_COOKIE}=${token}`;
}

const url = (path: string) => new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

async function json(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, body: await r.json() };
}

async function fund(accountId: string, amountCents: number) {
  const transactionId = await createTransaction(db, { accountId, type: "FUNDING", status: "COMPLETED", amountCents });
  await withTransaction(db, (tx) =>
    postLedgerEntry(tx, { accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }),
  );
  return transactionId;
}

/** A card authorization as in the ledger tests: ACTIVE hold plus its HOLD_CREATED step. */
async function authorize(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents });
  await withTransaction(db, async (tx) => {
    await tx.insert(holds).values({ transactionId, accountId: SEED.accountId, kind: "CARD_AUTHORIZATION", amountCents });
    await appendTraceEvent(tx, { accountId: SEED.accountId, transactionId, kind: "HOLD_CREATED", amountCents });
  });
  return transactionId;
}

beforeEach(async () => {
  cookie = undefined;
  await resetDb(db);
  await db.insert(businesses).values({ id: OTHER.businessId, name: "Other Co." });
  await db.insert(accounts).values({ id: OTHER.accountId, businessId: OTHER.businessId });
  await db
    .insert(users)
    .values({ id: OTHER.ownerUserId, businessId: OTHER.businessId, email: "owner@other.test", name: "Other Owner", role: "OWNER" });
  signIn(SEED.ownerUserId);
});
afterAll(() => pool.end());

describe("GET /api/account and /api/account/balance", () => {
  it("returns the owner's account and card", async () => {
    const { status, body } = await json(handleGetAccount(deps, url("/api/account")));
    expect(status).toBe(200);
    expect(body.account).toMatchObject({ id: SEED.accountId, businessName: "Acme Inc.", currency: "USD", status: "ACTIVE" });
    expect(body.cards).toEqual([expect.objectContaining({ id: SEED.cardId, last4: "4821", status: "ACTIVE" })]);
  });

  it("explains the balance with the domain formula: 500 / 420 while the $80 hold is active", async () => {
    await fund(SEED.accountId, 50000);
    await authorize(8000);
    const { body } = await json(handleGetBalance(deps, url("/api/account/balance")));
    expect(body).toMatchObject({ ledgerBalanceCents: 50000, pendingCardHoldsCents: 8000, pendingPaymentsCents: 0, availableCents: 42000 });
    expect(body.explanation.formula).toBe(BALANCE_FORMULA);
    expect(body.explanation.lines.map((l: { label: string; amountCents: number }) => [l.label, l.amountCents])).toEqual([
      ["Ledger balance", 50000],
      ["Pending card holds", 8000],
      ["Pending payments", 0],
    ]);
    expect(body.explanation.result).toEqual({ label: "Available balance", amountCents: 42000 });
  });

  it("is 401 signed out and 403 for OPS, with the error shape", async () => {
    cookie = undefined;
    expect(await json(handleGetAccount(deps, url("/api/account")))).toEqual({
      status: 401,
      body: { error: { code: "unauthenticated", message: "Sign in to continue" } },
    });
    signIn(SEED.opsUserId, "OPS");
    expect((await handleGetBalance(deps, url("/api/account/balance"))).status).toBe(403);
  });
});

describe("GET /api/transactions", () => {
  it("lists newest first with type and status filters, and only the owner's account", async () => {
    await seedDemoStory(db);
    await fund(OTHER.accountId, 1000);

    const all = await json(handleListTransactions(deps, url("/api/transactions")));
    expect(all.body.items.map((t: { id: string }) => t.id)).toEqual([DEMO.purchaseTransactionId, DEMO.fundingTransactionId]);
    expect(all.body.items[0]).toMatchObject({ type: "CARD_PURCHASE", status: "SETTLED", amountCents: 8000, postedCents: -6500, holdCents: 8000, holdStatus: "RELEASED" });
    expect(all.body.nextCursor).toBeNull();

    const purchases = await json(handleListTransactions(deps, url("/api/transactions?type=CARD_PURCHASE")));
    expect(purchases.body.items.map((t: { id: string }) => t.id)).toEqual([DEMO.purchaseTransactionId]);
    const completed = await json(handleListTransactions(deps, url("/api/transactions?type=FUNDING&status=SETTLED")));
    expect(completed.body.items.map((t: { id: string }) => t.id)).toEqual([DEMO.fundingTransactionId]);
    const none = await json(handleListTransactions(deps, url("/api/transactions?status=AUTHORIZED")));
    expect(none.body.items).toEqual([]);
  });

  it("pages with a cursor without skipping or repeating rows that share created_at", async () => {
    // Inserted in one database transaction, so all five share created_at = now().
    const ids = await withTransaction(db, async (tx) =>
      (
        await tx
          .insert(transactions)
          .values(Array.from({ length: 5 }, (_, i) => ({ accountId: SEED.accountId, type: "FUNDING" as const, status: "PENDING" as const, amountCents: 100 + i })))
          .returning({ id: transactions.id })
      ).map((row) => row.id),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/api/transactions?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await json(handleListTransactions(deps, url(query)));
      seen.push(...body.items.map((t: { id: string }) => t.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("rejects invalid query params with a useful message", async () => {
    const badType = await json(handleListTransactions(deps, url("/api/transactions?type=CASH")));
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe("invalid_request");
    expect(badType.body.error.message).toMatch(/^type: /);
    expect((await json(handleListTransactions(deps, url("/api/transactions?limit=0")))).status).toBe(400);
    const badCursor = await json(handleListTransactions(deps, url("/api/transactions?cursor=garbage")));
    expect(badCursor.body.error).toEqual({ code: "invalid_request", message: "cursor: is not a valid page cursor" });
  });
});

describe("GET /api/transactions/:id and /timeline", () => {
  it("timeline is 500/500 → 500/420 → 435/435 → 435/435 in order across funding and purchase", async () => {
    await seedDemoStory(db);
    const funding = await json(handleGetTimeline(deps, url("/x"), { id: DEMO.fundingTransactionId }));
    const purchase = await json(handleGetTimeline(deps, url("/x"), { id: DEMO.purchaseTransactionId }));
    type Step = { seq: number; accountSeq: number; kind: string; ledgerBalanceAfterCents: number; availableAfterCents: number; providerRef: string | null };
    const steps: Step[] = [...funding.body.steps, ...purchase.body.steps];
    expect(steps.map((s) => [s.accountSeq, s.kind, s.ledgerBalanceAfterCents, s.availableAfterCents])).toEqual([
      [1, "STATUS_CHANGED", 0, 0],
      [2, "LEDGER_POSTED", 50000, 50000],
      [3, "STATUS_CHANGED", 50000, 50000],
      [4, "HOLD_CREATED", 50000, 42000],
      [5, "LEDGER_POSTED", 43500, 43500],
      [6, "HOLD_RELEASED", 43500, 43500],
      [7, "STATUS_CHANGED", 43500, 43500],
    ]);
    // The money-moving steps alone tell the 500/500 → 500/420 → 435/435 → 435/435 story.
    expect(steps.filter((s) => s.kind !== "STATUS_CHANGED").map((s) => `${s.ledgerBalanceAfterCents}/${s.availableAfterCents}`)).toEqual([
      "50000/50000",
      "50000/42000",
      "43500/43500",
      "43500/43500",
    ]);
    expect(purchase.body.steps.map((s: Step) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(purchase.body.steps.map((s: Step) => s.providerRef)).toEqual([
      "demo_authorization_1",
      "demo_settlement_1",
      "demo_settlement_1",
      "demo_settlement_1",
    ]);
  });

  it("returns the transaction with ledger entries, hold, linked transactions and external records", async () => {
    await seedDemoStory(db);
    const [event] = await db
      .insert(externalEvents)
      .values({ provider: "increase", externalEventId: "evt_refund_1", eventType: "card_refund.created", payload: {}, correlationId: newId(), status: "PROCESSED" })
      .returning({ id: externalEvents.id });
    const reversal = await createTransaction(db, {
      type: "CARD_REVERSAL",
      status: "COMPLETED",
      amountCents: 2000,
      relatedTransactionId: DEMO.purchaseTransactionId,
      provider: "increase",
      providerObjectId: "card_refund_1",
    });
    await withTransaction(db, (tx) =>
      postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: reversal, entryType: "CARD_REVERSAL_CREDIT", amountCents: 2000, externalEventId: event.id, providerRef: "card_refund_1" }),
    );

    const purchase = await json(handleGetTransaction(deps, url("/x"), { id: DEMO.purchaseTransactionId }));
    expect(purchase.status).toBe(200);
    expect(purchase.body.transaction).toMatchObject({ id: DEMO.purchaseTransactionId, status: "SETTLED", amountCents: 8000, postedCents: -6500 });
    expect(purchase.body.ledgerEntries).toEqual([expect.objectContaining({ entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500 })]);
    expect(purchase.body.holds).toEqual([expect.objectContaining({ kind: "CARD_AUTHORIZATION", status: "RELEASED", amountCents: 8000 })]);
    expect(purchase.body.related).toEqual([expect.objectContaining({ id: reversal, type: "CARD_REVERSAL", relation: "follow_up" })]);
    expect(purchase.body.external).toEqual({ provider: "demo", providerObjectId: "demo_card_payment_1", events: [] });

    const refund = await json(handleGetTransaction(deps, url("/x"), { id: reversal }));
    expect(refund.body.related).toEqual([expect.objectContaining({ id: DEMO.purchaseTransactionId, relation: "original" })]);
    expect(refund.body.external.events).toEqual([
      expect.objectContaining({ id: event.id, provider: "increase", externalEventId: "evt_refund_1", eventType: "card_refund.created" }),
    ]);
    const refundTimeline = await json(handleGetTimeline(deps, url("/x"), { id: reversal }));
    expect(refundTimeline.body.steps).toEqual([
      expect.objectContaining({ kind: "LEDGER_POSTED", externalEventId: "evt_refund_1", eventId: event.id, provider: "increase", ledgerBalanceAfterCents: 45500 }),
    ]);
  });

  it("an owner can't read another business's transaction (404, same as missing)", async () => {
    const theirs = await fund(OTHER.accountId, 1000);
    const notFound = { status: 404, body: { error: { code: "transaction_not_found", message: "No transaction with that id on your account" } } };
    expect(await json(handleGetTransaction(deps, url("/x"), { id: theirs }))).toEqual(notFound);
    expect(await json(handleGetTimeline(deps, url("/x"), { id: theirs }))).toEqual(notFound);
    expect(await json(handleGetTransaction(deps, url("/x"), { id: newId() }))).toEqual(notFound);

    signIn(OTHER.ownerUserId, "OWNER", OTHER.accountId);
    expect((await handleGetTransaction(deps, url("/x"), { id: theirs })).status).toBe(200);
  });

  it("rejects an id that isn't a UUID", async () => {
    expect(await json(handleGetTransaction(deps, url("/x"), { id: "1 OR 1=1" }))).toEqual({
      status: 400,
      body: { error: { code: "invalid_request", message: "id: must be a transaction id" } },
    });
  });
});
