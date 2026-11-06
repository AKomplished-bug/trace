import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../db/client";
import { accounts, businesses, cards, externalEvents, holds, ledgerEntries, transactionEvents, transactions } from "../../db/schema";
import { SEED } from "../../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../../db/test-helpers";
import type { CardPaymentElement } from "../../domain/cards";
import { sessionConfig } from "../../lib/config";
import { newId } from "../../lib/ids";
import { logger } from "../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../lib/session";
import { applyCardPayment } from "../../services/cards";
import { DEMO, seedDemoStory } from "../../services/demo";
import { transitionHold } from "../../services/holds";
import { postLedgerEntry } from "../../services/ledger";
import { getAccountReplay, getBalanceExplanation, type TransactionReplay } from "../../services/replay-queries";
import { appendTraceEvent } from "../../services/trace";
import { handleGetReplay } from "./transactions/handle-transactions";

const { pool, db } = createTestDb();
const deps = { db, logger };
const PROVIDER_CARD_ID = "card_replay_test";
const OTHER = { businessId: "00000000-0000-4000-8000-0000000000b1", accountId: "00000000-0000-4000-8000-0000000000b2" };

let cookie: string | undefined;
function signIn() {
  const token = signSession(
    { userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionConfig().SESSION_SECRET,
  );
  cookie = `${SESSION_COOKIE}=${token}`;
}

async function replayOf(id: string): Promise<{ status: number; body: TransactionReplay }> {
  const response = await handleGetReplay(deps, new Request("http://localhost/x", { headers: cookie ? { cookie } : {} }), { id });
  return { status: response.status, body: await response.json() };
}

const money = (replay: TransactionReplay) => [
  `${replay.initial.ledgerCents / 100}/${replay.initial.availableCents / 100}`,
  ...replay.steps.map((s) => `${s.after.ledgerCents / 100}/${s.after.availableCents / 100}`),
];

async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
  return transactionId;
}

/** Applies a card payment snapshot (every element so far) through the card service, as the worker does. */
async function cardPayment(id: string, elements: CardPaymentElement[]) {
  const [event] = await db
    .insert(externalEvents)
    .values({ provider: "increase", externalEventId: `evt_${newId()}`, eventType: "card_payment.updated", payload: {}, correlationId: newId(), status: "PROCESSING" })
    .returning({ id: externalEvents.id });
  await withTransaction(db, (tx) =>
    applyCardPayment(tx, { eventId: event.id, provider: "increase", cardPayment: { id, cardId: PROVIDER_CARD_ID, elements, requestId: null } }, logger),
  );
  const [purchase] = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.providerObjectId, id), eq(transactions.type, "CARD_PURCHASE")));
  return purchase?.id;
}

const auth = (amountCents: number): CardPaymentElement => ({ kind: "AUTHORIZATION", id: `auth_${amountCents}`, amountCents, merchant: "FIGMA.COM", expiresAt: null });
const settle = (amountCents: number): CardPaymentElement => ({ kind: "SETTLEMENT", id: `settle_${amountCents}`, amountCents });

async function expectAccountReplayMatches() {
  const replay = await getAccountReplay(db, SEED.accountId);
  const { cachedCents, ledgerSumCents } = await balances(db);
  expect(replay).toMatchObject({ consistent: true, matchesStored: true, mismatches: [] });
  expect(replay!.final.ledgerCents).toBe(cachedCents);
  expect(replay!.final.ledgerCents).toBe(ledgerSumCents);
}

beforeEach(async () => {
  await resetDb(db);
  await db.update(cards).set({ providerId: PROVIDER_CARD_ID }).where(eq(cards.id, SEED.cardId));
  signIn();
});
afterAll(() => pool.end());

describe("GET /api/transactions/:id/replay — spec stories", () => {
  it("demo purchase: 500/500 → 500/420 → 435/435 → 435/435, consistent, with its money graph", async () => {
    await seedDemoStory(db);
    const { status, body } = await replayOf(DEMO.purchaseTransactionId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ transactionId: DEMO.purchaseTransactionId, consistent: true, divergence: null });
    expect(money(body)).toEqual(["500/500", "500/420", "435/435", "435/435", "435/435"]);
    expect(body.steps.map((s) => [s.event.kind, s.explanation])).toEqual([
      ["HOLD_CREATED", "hold_created"],
      ["LEDGER_POSTED", "settlement_released_hold"],
      ["HOLD_RELEASED", "hold_released_with_settlement"],
      ["STATUS_CHANGED", "status_changed"],
    ]);
    expect(body.graph.nodes.map((n) => n.type)).toEqual(["external", "hold", "external", "ledger_entry", "balance"]);
    expect(body.graph.edges.map((e) => e.kind)).toEqual(["created", "posted", "closed_by", "updated"]);
    expect(JSON.stringify(body)).not.toContain("payload");

    const funding = await replayOf(DEMO.fundingTransactionId);
    expect(funding.body.consistent).toBe(true);
    expect(money(funding.body)).toEqual(["0/0", "0/0", "500/500", "500/500"]);
    await expectAccountReplayMatches();
  });

  it("expiry, void, late settlement after expiry and an over-available authorization all replay consistently", async () => {
    await fund(10000);
    const expired = await cardPayment("cp_expired", [auth(3000)]);
    await cardPayment("cp_expired", [auth(3000), { kind: "EXPIRATION", id: "exp_1", amountCents: 3000 }]);
    const voided = await cardPayment("cp_void", [auth(2000)]);
    await cardPayment("cp_void", [auth(2000), { kind: "REVERSAL", id: "rev_1", amountCents: 2000, remainingAuthorizationCents: 0 }]);
    await cardPayment("cp_expired", [auth(3000), { kind: "EXPIRATION", id: "exp_1", amountCents: 3000 }, settle(2500)]);
    const over = await cardPayment("cp_over", [auth(12000)]);

    const expiredReplay = (await replayOf(expired!)).body;
    expect(expiredReplay.consistent).toBe(true);
    expect(expiredReplay.steps.map((s) => s.explanation)).toEqual([
      "hold_created",
      "hold_expired",
      "status_changed",
      "ledger_posted",
      "settled_after_hold_closed",
      "status_changed",
    ]);
    // The void happened between the expiry and the late settlement: other activity, not ours.
    expect(expiredReplay.steps[3].otherActivity).toBeNull();
    expect(money(expiredReplay)).toEqual(["100/100", "100/70", "100/100", "100/100", "75/75", "75/75", "75/75"]);

    const voidReplay = (await replayOf(voided!)).body;
    expect(voidReplay.consistent).toBe(true);
    expect(voidReplay.steps.map((s) => s.explanation)).toEqual(["hold_created", "hold_released", "status_changed"]);

    const overReplay = (await replayOf(over!)).body;
    expect(overReplay.consistent).toBe(true);
    expect(money(overReplay)).toEqual(["75/75", "75/-45", "75/-45"]);
    expect(overReplay.steps[1].explanation).toBe("hold_exceeds_available");
    await expectAccountReplayMatches();
  });

  it("refund: the purchase and its CARD_REVERSAL both replay consistently, the graph links them", async () => {
    await fund(50000);
    const purchase = await cardPayment("cp_refund", [auth(8000)]);
    await cardPayment("cp_refund", [auth(8000), settle(6500)]);
    await cardPayment("cp_refund", [auth(8000), settle(6500), { kind: "REFUND", id: "refund_1", amountCents: 6500, merchant: null }]);
    const [refund] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.type, "CARD_REVERSAL"));

    const purchaseReplay = (await replayOf(purchase!)).body;
    expect(purchaseReplay.consistent).toBe(true);
    expect(purchaseReplay.graph.nodes.at(-1)).toMatchObject({ type: "transaction", transactionId: refund.id, relation: "follow_up" });
    const refundReplay = (await replayOf(refund.id)).body;
    expect(refundReplay.consistent).toBe(true);
    expect(money(refundReplay)).toEqual(["435/435", "500/500", "500/500"]);
    expect(refundReplay.graph.nodes[0]).toMatchObject({ type: "transaction", transactionId: purchase, relation: "original" });
    await expectAccountReplayMatches();
  });

  it("a pending payment hold, completed with its debit, replays consistently", async () => {
    await fund(50000);
    const payment = await createTransaction(db, { type: "OUTBOUND_PAYMENT", status: "PENDING", amountCents: 10000 });
    await withTransaction(db, async (tx) => {
      await tx.insert(holds).values({ transactionId: payment, accountId: SEED.accountId, kind: "PENDING_PAYMENT", amountCents: 10000 });
      await appendTraceEvent(tx, { accountId: SEED.accountId, transactionId: payment, kind: "HOLD_CREATED", amountCents: 10000 });
    });
    await withTransaction(db, (tx) =>
      postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: payment, entryType: "PAYMENT_DEBIT", amountCents: -10000, releaseHoldForTransactionId: payment }),
    );
    const { body } = await replayOf(payment);
    expect(body.consistent).toBe(true);
    expect(money(body)).toEqual(["500/500", "500/400", "400/400", "400/400"]);
    expect(body.final.holds[Object.keys(body.final.holds)[0]]).toMatchObject({ kind: "PENDING_PAYMENT", status: "RELEASED" });
    await expectAccountReplayMatches();
  });

  it("with other transactions interleaved, checks this transaction's deltas against the running balances", async () => {
    await fund(50000);
    const first = await cardPayment("cp_a", [auth(8000)]);
    await cardPayment("cp_b", [{ ...auth(2000), id: "auth_b" }]);
    await fund(10000);
    await cardPayment("cp_a", [auth(8000), settle(6500)]);
    const { body } = await replayOf(first!);
    expect(body.consistent).toBe(true);
    expect(money(body)).toEqual(["500/500", "500/420", "535/515", "535/515", "535/515"]);
    expect(body.steps[1].otherActivity).toEqual({ ledgerCents: 10000, availableCents: 8000 });
    await expectAccountReplayMatches();
  });
});

describe("GET /api/transactions/:id/replay — verification and access", () => {
  it("a tampered available_after_cents makes the replay inconsistent at that step", async () => {
    await seedDemoStory(db);
    const [settlement] = await db
      .select({ id: transactionEvents.id })
      .from(transactionEvents)
      .where(and(eq(transactionEvents.transactionId, DEMO.purchaseTransactionId), eq(transactionEvents.kind, "LEDGER_POSTED")));
    // Test-only corruption of a stored row; nothing in the application updates the trace.
    await db.update(transactionEvents).set({ availableAfterCents: 40000 }).where(eq(transactionEvents.id, settlement.id));

    const { status, body } = await replayOf(DEMO.purchaseTransactionId);
    expect(status).toBe(200);
    expect(body.consistent).toBe(false);
    expect(body.divergence).toEqual({
      stepIndex: 1,
      reason: "balances",
      eventId: settlement.id,
      accountSeq: 5,
      // The tampered row no longer records the same balances as its HOLD_RELEASED, so it isn't
      // paired as a settlement: replay expects a plain posting with the $80 hold still counted.
      replayed: { ledgerCents: 43500, availableCents: 35500 },
      recorded: { ledgerCents: 43500, availableCents: 40000 },
    });
    // Only the tampered row: the next rows are consecutive on the account, so replay carries on
    // from its own state rather than from the bad recorded value.
    expect(body.steps.map((s) => s.matches)).toEqual([true, false, true, true]);
    expect((await getAccountReplay(db, SEED.accountId))?.matchesStored).toBe(false);
  });

  it("logs a replay_mismatch with the account, transaction and step", async () => {
    await seedDemoStory(db);
    await db
      .update(transactionEvents)
      .set({ availableAfterCents: 40000 })
      .where(and(eq(transactionEvents.transactionId, DEMO.purchaseTransactionId), eq(transactionEvents.kind, "LEDGER_POSTED")));
    const lines: Array<Record<string, unknown>> = [];
    const capture = pino({ level: "warn" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    await handleGetReplay({ db, logger: capture }, new Request("http://localhost/x", { headers: { cookie: cookie! } }), { id: DEMO.purchaseTransactionId });
    expect(lines.filter((line) => line.outcome === "replay_mismatch")).toEqual([
      expect.objectContaining({ scope: "transaction", account_id: SEED.accountId, transaction_id: DEMO.purchaseTransactionId, account_seq: 5, step: 2, reason: "balances" }),
    ]);
  });

  it("a ledger entry that drifted from its trace row makes the transaction replay inconsistent", async () => {
    await seedDemoStory(db);
    // Test-only corruption: the ledger is append-only in the application.
    await db.update(ledgerEntries).set({ amountCents: -6000 }).where(eq(ledgerEntries.transactionId, DEMO.purchaseTransactionId));
    const { body } = await replayOf(DEMO.purchaseTransactionId);
    expect(body.consistent).toBe(false);
    expect(body.divergence).toMatchObject({ stepIndex: 1, reason: "ledger_entry", accountSeq: 5 });
    expect(body.steps.map((s) => s.matches)).toEqual([true, false, true, true]);
  });

  it("a debit and its hold release in two separate database transactions replay consistently", async () => {
    await fund(50000);
    const payment = await createTransaction(db, { type: "OUTBOUND_PAYMENT", status: "PENDING", amountCents: 10000 });
    await withTransaction(db, async (tx) => {
      await tx.insert(holds).values({ transactionId: payment, accountId: SEED.accountId, kind: "PENDING_PAYMENT", amountCents: 10000 });
      await appendTraceEvent(tx, { accountId: SEED.accountId, transactionId: payment, kind: "HOLD_CREATED", amountCents: 10000 });
    });
    await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: payment, entryType: "PAYMENT_DEBIT", amountCents: -10000 }));
    await withTransaction(db, (tx) => transitionHold(tx, { accountId: SEED.accountId, transactionId: payment, event: "RELEASE" }));
    const { body } = await replayOf(payment);
    expect(body.steps.map((s) => s.event.accountSeq)).toEqual([2, 3, 4]);
    expect(body.consistent).toBe(true);
    expect(money(body)).toEqual(["500/500", "500/400", "400/300", "400/400"]);
    expect(body.steps.map((s) => s.explanation)).toEqual(["hold_created", "ledger_posted", "hold_released"]);
    await expectAccountReplayMatches();
  });

  it("another business's transaction is 404, like a missing one; signed out is 401; a bad id is 400", async () => {
    await db.insert(businesses).values({ id: OTHER.businessId, name: "Other Co." });
    await db.insert(accounts).values({ id: OTHER.accountId, businessId: OTHER.businessId });
    const theirs = await createTransaction(db, { accountId: OTHER.accountId, type: "FUNDING", status: "SETTLED", amountCents: 1000 });
    await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: OTHER.accountId, transactionId: theirs, entryType: "FUNDING_CREDIT", amountCents: 1000 }));

    const notFound = { code: "transaction_not_found", message: "No transaction with that id on your account" };
    expect(await replayOf(theirs)).toEqual({ status: 404, body: { error: notFound } });
    expect(await replayOf(newId())).toEqual({ status: 404, body: { error: notFound } });
    expect((await replayOf("nope")).status).toBe(400);
    cookie = undefined;
    expect((await replayOf(theirs)).status).toBe(401);
  });

  it("never writes: the replay leaves every table as it was", async () => {
    await seedDemoStory(db);
    const before = await db.select().from(transactionEvents);
    await replayOf(DEMO.purchaseTransactionId);
    expect(await db.select().from(transactionEvents)).toEqual(before);
    expect(await balances(db)).toMatchObject({ cachedCents: 43500, ledgerSumCents: 43500 });
  });
});

describe("balance explanation", () => {
  it("decomposes available into ledger − pending holds, lists each active hold with its transaction, and re-derives it by replay", async () => {
    await fund(50000);
    const purchase = await cardPayment("cp_pending", [auth(8000)]);
    const view = await getBalanceExplanation(db, SEED.accountId);
    expect(view?.balance).toMatchObject({ ledgerBalanceCents: 50000, pendingCardHoldsCents: 8000, pendingPaymentsCents: 0, availableCents: 42000 });
    expect(view?.activeHolds).toEqual([
      expect.objectContaining({ kind: "CARD_AUTHORIZATION", amountCents: 8000, transactionId: purchase, type: "CARD_PURCHASE", status: "AUTHORIZED", counterparty: "FIGMA.COM" }),
    ]);
    expect(view?.replay).toMatchObject({ stepCount: 2, matchesStored: true, final: { ledgerCents: 50000, availableCents: 42000 } });
  });
});
