import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../app/api/webhooks/handle-webhook";
import { withTransaction } from "../db/client";
import { cards, eventDeliveries, externalEvents, holds, ledgerEntries, transactionEvents, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { INCREASE_IGNORED_EVENT_TYPES } from "../integrations/increase";
import { cardPaymentEvent, createFakeIncrease, seedCardPayment, signedIncreaseWebhook, type CardPaymentJson, type FakeIncrease } from "../integrations/increase/fake-increase";
import reversedFixture from "../integrations/increase/fixtures/card_payment.reversed.json";
import settledFixture from "../integrations/increase/fixtures/card_payment.settled.json";
import standaloneRefund from "../integrations/increase/fixtures/card_payment.standalone_refund.json";
import pendingCreated from "../integrations/increase/fixtures/event.pending_transaction.created.json";
import { logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "../services/accounts";
import { postLedgerEntry } from "../services/ledger";
import { claimNextEvent, processEvent, type ProcessOutcome } from "./events";
import { handlerKey, type EventRouting } from "./handlers";
import { increaseHandlers } from "./increase";

const { pool, db } = createTestDb(20);
const PROVIDER_CARD_ID = "card_oubs0hwk5rn6knuecxg2";
let fake: FakeIncrease;

function routing(): EventRouting {
  const handlers = Object.fromEntries(
    Object.entries(increaseHandlers(() => fake.adapter)).map(([type, handler]) => [handlerKey("increase", type), handler]),
  );
  return { handlers, ignored: { increase: INCREASE_IGNORED_EVENT_TYPES } };
}

/** Runs the worker until no event is due; returns each outcome. */
async function drain(): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  for (let event = await claimNextEvent(db, { leaseSeconds: 60 }); event; event = await claimNextEvent(db, { leaseSeconds: 60 })) {
    outcomes.push(await processEvent(db, event, routing(), logger));
  }
  return outcomes;
}

async function deliver(payload: { id: string }) {
  const { body, headers } = signedIncreaseWebhook(payload);
  const request = new Request("http://localhost/api/webhooks/increase", { method: "POST", body, headers });
  const response = await handleWebhook({ db, webhookVerifiers: { increase: fake.adapter }, logger }, "increase", request);
  expect(response.status).toBe(200);
}

/** Delivers a fresh event for the card payment (Increase sends one per change) and runs the worker. */
async function notify(cardPaymentId: string, category = "card_payment.updated") {
  const event = cardPaymentEvent(cardPaymentId, category);
  await deliver(event);
  return { event, outcomes: await drain() };
}

/** Funds the account through the ledger service, as a settled Stripe funding would. */
async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

async function authorize(amountCents: number, merchant?: string) {
  const { cardPaymentId } = await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents, merchant });
  expect((await notify(cardPaymentId, "card_payment.created")).outcomes).toEqual(["processed"]);
  return cardPaymentId;
}

async function account() {
  const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  expect(replayMatches).toBe(true);
  const availableCents = await withTransaction(db, async (tx) =>
    accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents),
  );
  return { ledgerCents: cachedCents, availableCents };
}

async function purchase(cardPaymentId: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.providerObjectId, cardPaymentId));
  return row;
}

async function holdOf(transactionId: string) {
  const [row] = await db.select().from(holds).where(eq(holds.transactionId, transactionId));
  return row;
}

async function trace(transactionId: string) {
  return db.select().from(transactionEvents).where(eq(transactionEvents.transactionId, transactionId)).orderBy(asc(transactionEvents.seq));
}

const elementId = (cardPaymentId: string, index: number) => {
  const element = fake.cardPayments.get(cardPaymentId)!.elements[index];
  return (element[element.category as string] as { id: string }).id;
};

const cardEntries = () => db.select().from(ledgerEntries).where(sql`${ledgerEntries.entryType} <> 'FUNDING_CREDIT'`).orderBy(asc(ledgerEntries.createdAt));

beforeEach(async () => {
  await resetDb(db);
  await db.update(cards).set({ providerId: PROVIDER_CARD_ID }).where(eq(cards.id, SEED.cardId));
  fake = createFakeIncrease();
});
afterAll(() => pool.end());

describe("Increase card lifecycle through webhook ingestion and the worker", () => {
  it("fund $500, authorize $80 → 500/420, settle $65 → 435/435 with LEDGER_POSTED −6500 then HOLD_RELEASED", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000, "FIGMA.COM");
    const authorized = await purchase(cardPaymentId);
    expect(authorized).toMatchObject({ type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents: 8000, provider: "increase", counterparty: "FIGMA.COM" });
    expect(await holdOf(authorized.id)).toMatchObject({ kind: "CARD_AUTHORIZATION", status: "ACTIVE", amountCents: 8000 });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 42000 });

    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    const { event, outcomes } = await notify(cardPaymentId);
    expect(outcomes).toEqual(["processed"]);
    expect(await account()).toEqual({ ledgerCents: 43500, availableCents: 43500 });
    expect((await purchase(cardPaymentId)).status).toBe("SETTLED");
    expect((await holdOf(authorized.id)).status).toBe("RELEASED");
    expect(await cardEntries()).toMatchObject([{ transactionId: authorized.id, entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500 }]);

    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored).toMatchObject({ status: "PROCESSED", transactionId: authorized.id });
    const [authId, settlementId] = [elementId(cardPaymentId, 0), elementId(cardPaymentId, 1)];
    expect((await trace(authorized.id)).map((t) => [t.kind, t.ledgerDeltaCents, t.fromStatus, t.toStatus, t.ledgerBalanceAfterCents, t.availableAfterCents, t.providerRef])).toEqual([
      ["HOLD_CREATED", 0, null, "ACTIVE", 50000, 42000, authId],
      ["LEDGER_POSTED", -6500, null, null, 43500, 43500, settlementId],
      ["HOLD_RELEASED", 0, "ACTIVE", "RELEASED", 43500, 43500, settlementId],
      ["STATUS_CHANGED", 0, "AUTHORIZED", "SETTLED", 43500, 43500, settlementId],
    ]);
  });

  it("the same card_payment.updated twice, a later event and an older snapshot have no extra effect", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000);
    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    const event = cardPaymentEvent(cardPaymentId);
    await deliver(event);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);
    const { id } = await purchase(cardPaymentId);
    const before = { trace: await trace(id), entries: await cardEntries() };

    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);
    // An older snapshot (authorization only), e.g. a delayed read from before the settlement.
    const current = fake.cardPayments.get(cardPaymentId)!;
    fake.cardPayments.set(cardPaymentId, { ...current, elements: current.elements.slice(0, 1) });
    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);

    expect(await trace(id)).toEqual(before.trace);
    expect(await cardEntries()).toEqual(before.entries);
    expect(await db.$count(eventDeliveries, eq(eventDeliveries.isDuplicate, true))).toBe(1);
    expect(await db.$count(transactions, eq(transactions.type, "CARD_PURCHASE"))).toBe(1);
    expect(await account()).toEqual({ ledgerCents: 43500, availableCents: 43500 });
  });

  it("two workers processing created and updated at once apply each step once", async () => {
    await fund(50000);
    const { cardPaymentId } = await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents: 8000 });
    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    await deliver(cardPaymentEvent(cardPaymentId, "card_payment.created"));
    await deliver(cardPaymentEvent(cardPaymentId, "card_payment.updated"));
    const claimed = [await claimNextEvent(db, { leaseSeconds: 60 }), await claimNextEvent(db, { leaseSeconds: 60 })];
    const outcomes = await Promise.all(claimed.map((event) => processEvent(db, event!, routing(), logger)));
    expect(outcomes).toEqual(["processed", "processed"]);
    expect(await cardEntries()).toHaveLength(1);
    expect((await trace((await purchase(cardPaymentId)).id)).map((t) => t.kind)).toEqual(["HOLD_CREATED", "LEDGER_POSTED", "HOLD_RELEASED", "STATUS_CHANGED"]);
    expect(await account()).toEqual({ ledgerCents: 43500, availableCents: 43500 });
  });

  it("expiry: hold EXPIRED, purchase EXPIRED, available restored, no ledger entry", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000);
    await fake.adapter.simulateExpiration({ cardPaymentId });
    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);
    const expired = await purchase(cardPaymentId);
    expect(expired.status).toBe("EXPIRED");
    expect((await holdOf(expired.id)).status).toBe("EXPIRED");
    expect(await cardEntries()).toHaveLength(0);
    expect((await trace(expired.id)).map((t) => [t.kind, t.toStatus, t.availableAfterCents])).toEqual([
      ["HOLD_CREATED", "ACTIVE", 42000],
      ["HOLD_EXPIRED", "EXPIRED", 50000],
      ["STATUS_CHANGED", "EXPIRED", 50000],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("expiry then a late settlement still posts, with SETTLED_AFTER_HOLD_CLOSED", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000);
    await fake.adapter.simulateExpiration({ cardPaymentId });
    await notify(cardPaymentId);
    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);
    const settled = await purchase(cardPaymentId);
    expect(settled.status).toBe("SETTLED");
    expect((await trace(settled.id)).slice(3).map((t) => [t.kind, t.fromStatus, t.toStatus, t.ledgerDeltaCents])).toEqual([
      ["LEDGER_POSTED", null, null, -6500],
      ["SETTLED_AFTER_HOLD_CLOSED", "EXPIRED", "EXPIRED", 0],
      ["STATUS_CHANGED", "EXPIRED", "SETTLED", 0],
    ]);
    expect(await account()).toEqual({ ledgerCents: 43500, availableCents: 43500 });
  });

  it("a refund after settlement is a new CARD_REVERSAL +$65 linked to the purchase; net 0, original kept", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000, "FIGMA.COM");
    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    await notify(cardPaymentId);
    const original = await purchase(cardPaymentId);

    await fake.adapter.simulateReversal({ cardPaymentId });
    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);
    const refundId = elementId(cardPaymentId, 2);
    const [reversal] = await db.select().from(transactions).where(eq(transactions.type, "CARD_REVERSAL"));
    expect(reversal).toMatchObject({ status: "SETTLED", amountCents: 6500, provider: "increase", providerObjectId: refundId, relatedTransactionId: original.id, counterparty: "FIGMA.COM" });
    expect(await purchase(cardPaymentId)).toEqual(original);
    expect((await cardEntries()).map((e) => [e.transactionId, e.amountCents])).toEqual([
      [original.id, -6500],
      [reversal.id, 6500],
    ]);
    expect((await trace(reversal.id)).map((t) => [t.kind, t.ledgerDeltaCents, t.toStatus, t.providerRef])).toEqual([
      ["LEDGER_POSTED", 6500, null, refundId],
      ["STATUS_CHANGED", 0, "SETTLED", refundId],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("two partial refunds stack as two reversals", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000);
    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    await notify(cardPaymentId);
    await fake.adapter.simulateReversal({ cardPaymentId, amountCents: 2000 });
    await notify(cardPaymentId);
    await fake.adapter.simulateReversal({ cardPaymentId, amountCents: 1500 });
    await notify(cardPaymentId);
    await notify(cardPaymentId);

    const reversals = await db.select().from(transactions).where(eq(transactions.type, "CARD_REVERSAL")).orderBy(asc(transactions.createdAt));
    expect(reversals.map((r) => [r.amountCents, r.relatedTransactionId])).toEqual([
      [2000, (await purchase(cardPaymentId)).id],
      [1500, (await purchase(cardPaymentId)).id],
    ]);
    expect(await account()).toEqual({ ledgerCents: 47000, availableCents: 47000 });
  });

  it("a void before settlement releases the hold, purchase REVERSED, no ledger entry", async () => {
    await fund(50000);
    const cardPaymentId = await authorize(8000);
    await fake.adapter.simulateReversal({ cardPaymentId });
    expect((await notify(cardPaymentId)).outcomes).toEqual(["processed"]);
    const voided = await purchase(cardPaymentId);
    expect(voided.status).toBe("REVERSED");
    expect((await holdOf(voided.id)).status).toBe("RELEASED");
    expect(await cardEntries()).toHaveLength(0);
    expect(await db.$count(transactions, eq(transactions.type, "CARD_REVERSAL"))).toBe(0);
    expect((await trace(voided.id)).map((t) => [t.kind, t.fromStatus, t.toStatus, t.providerRef])).toEqual([
      ["HOLD_CREATED", null, "ACTIVE", elementId(cardPaymentId, 0)],
      ["HOLD_RELEASED", "ACTIVE", "RELEASED", elementId(cardPaymentId, 1)],
      ["STATUS_CHANGED", "AUTHORIZED", "REVERSED", elementId(cardPaymentId, 1)],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a settlement without a recorded authorization retries and posts nothing", async () => {
    await fund(50000);
    const forced = seedCardPayment(fake, { ...structuredClone(settledFixture), elements: structuredClone(settledFixture.elements.slice(1)) } as unknown as CardPaymentJson);
    const { event, outcomes } = await notify(forced.id);
    expect(outcomes).toEqual(["retry"]);
    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored.lastError).toBe(`CardPurchaseNotFoundError: SETTLEMENT card_settlement_khv5kfeu0vndj291omg6 on card payment ${forced.id} has no recorded authorization`);
    expect(await cardEntries()).toHaveLength(0);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("ignores at once a card payment on a card that isn't ours", async () => {
    await db.update(cards).set({ providerId: null });
    const cardPaymentId = (await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents: 8000 })).cardPaymentId;
    const { event, outcomes } = await notify(cardPaymentId);
    expect(outcomes).toEqual(["not_ours"]);
    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored).toMatchObject({ status: "IGNORED", attempts: 1, lastError: `not ours: CardNotOursError: No card with increase id ${PROVIDER_CARD_ID} for card payment ${cardPaymentId}` });
    expect(await db.$count(transactions)).toBe(0);
  });

  it("records an approved authorization above available and flags it in the trace", async () => {
    await fund(5000);
    const cardPaymentId = await authorize(8000);
    const { id } = await purchase(cardPaymentId);
    expect((await trace(id)).map((t) => [t.kind, t.availableAfterCents])).toEqual([
      ["HOLD_CREATED", -3000],
      ["HOLD_EXCEEDS_AVAILABLE", -3000],
    ]);
    expect(await account()).toEqual({ ledgerCents: 5000, availableCents: -3000 });
  });

  it("credits a refund that arrives on its own card payment, unlinked", async () => {
    seedCardPayment(fake, standaloneRefund as unknown as CardPaymentJson);
    expect((await notify(standaloneRefund.id)).outcomes).toEqual(["processed"]);
    expect((await notify(standaloneRefund.id)).outcomes).toEqual(["processed"]);
    const [reversal] = await db.select().from(transactions);
    expect(reversal).toMatchObject({ type: "CARD_REVERSAL", amountCents: 6500, providerObjectId: "card_refund_q8w2mzt0x3n4b5v6c7d8", relatedTransactionId: null });
    expect(await account()).toEqual({ ledgerCents: 6500, availableCents: 6500 });
  });

  it("fails a partial authorization reversal to Ops at once, applying nothing from that snapshot", async () => {
    await fund(50000);
    const partial = structuredClone(reversedFixture) as unknown as CardPaymentJson;
    Object.assign(partial.elements[1].card_reversal as object, { reversal_amount: 3000, updated_authorization_amount: 5000 });
    seedCardPayment(fake, partial);
    const { event, outcomes } = await notify(partial.id);
    expect(outcomes).toEqual(["failed"]);
    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored).toMatchObject({ attempts: 1, lastError: expect.stringContaining("UnsupportedCardElementError") });
    expect(await db.$count(transactions, eq(transactions.type, "CARD_PURCHASE"))).toBe(0);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a declined authorization records nothing", async () => {
    fake.next = "decline";
    const { cardPaymentId, declined } = await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents: 8000 });
    expect(declined).toBe(true);
    expect((await notify(cardPaymentId, "card_payment.created")).outcomes).toEqual(["processed"]);
    expect(await db.$count(transactions)).toBe(0);
  });

  it("marks listed irrelevant Increase events IGNORED", async () => {
    await deliver(pendingCreated);
    expect(await drain()).toEqual(["ignored"]);
  });
});
