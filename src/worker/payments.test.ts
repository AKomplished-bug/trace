import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../app/api/webhooks/handle-webhook";
import { withTransaction } from "../db/client";
import { accounts, externalEvents, holds, ledgerEntries, payments, transactionEvents, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { INCREASE_IGNORED_EVENT_TYPES } from "../integrations/increase";
import { achTransferEvent, createFakeIncrease, signedIncreaseWebhook, type FakeIncrease } from "../integrations/increase/fake-increase";
import { logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "../services/accounts";
import { postLedgerEntry } from "../services/ledger";
import { createPayment, paymentIdempotencyKey, type Payment } from "../services/payments";
import { claimNextEvent, processEvent, type ProcessOutcome } from "./events";
import { handlerKey, type EventRouting } from "./handlers";
import { increaseTransferHandlers } from "./increase";
import { claimNextPayment, MAX_SUBMIT_ATTEMPTS, submitPayment } from "./payment-submitter";

const { pool, db } = createTestDb(20);
const PROVIDER_ACCOUNT_ID = "account_in71c4amph0vgo2qllky";
let fake: FakeIncrease;

function routing(): EventRouting {
  const handlers = Object.fromEntries(
    Object.entries(increaseTransferHandlers(() => fake.adapter)).map(([type, handler]) => [handlerKey("increase", type), handler]),
  );
  return { handlers, ignored: { increase: INCREASE_IGNORED_EVENT_TYPES } };
}

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
  expect((await handleWebhook({ db, webhookVerifiers: { increase: fake.adapter }, logger }, "increase", request)).status).toBe(200);
}

/** Delivers a fresh ach_transfer event (Increase sends one per change) and runs the worker. */
async function notify(transferId: string, category = "ach_transfer.updated") {
  const event = achTransferEvent(transferId, category);
  await deliver(event);
  return { event, outcomes: await drain() };
}

async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

async function pay(amountCents = 10000): Promise<Payment> {
  const input = { accountId: SEED.accountId, recipientName: "Globex Supplies", accountNumber: "987654321", routingNumber: "101050001", amountCents, description: "Invoice 2468", idempotencyKey: crypto.randomUUID() };
  return (await createPayment(db, { name: "increase" }, input, logger)).payment;
}

/** Pays $100 and lets the submitter hand it to Increase, plus Increase's ach_transfer.created webhook. */
async function submitted(): Promise<{ payment: Payment; transferId: string }> {
  const payment = await pay();
  const claim = await claimNextPayment(db, { leaseSeconds: 60 });
  expect(await submitPayment(db, claim!, fake.adapter, logger)).toBe("submitted");
  const transferId = (await current(payment.id)).providerObjectId!;
  expect((await notify(transferId, "ach_transfer.created")).outcomes).toEqual(["processed"]);
  return { payment, transferId };
}

async function account() {
  const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  expect(replayMatches).toBe(true);
  const availableCents = await withTransaction(db, async (tx) => accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents));
  return { ledgerCents: cachedCents, availableCents };
}

const current = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const transactionOf = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const holdOf = async (transactionId: string) => (await db.select().from(holds).where(eq(holds.transactionId, transactionId)))[0];
const trace = (transactionId: string) =>
  db.select().from(transactionEvents).where(eq(transactionEvents.transactionId, transactionId)).orderBy(asc(transactionEvents.seq));
const paymentEntries = () => db.select().from(ledgerEntries).where(sql`${ledgerEntries.entryType} <> 'FUNDING_CREDIT'`).orderBy(asc(ledgerEntries.createdAt));
const steps = async (transactionId: string) =>
  (await trace(transactionId)).map((t) => [t.kind, t.fromStatus, t.toStatus, t.ledgerDeltaCents, t.ledgerBalanceAfterCents, t.availableAfterCents]);

beforeEach(async () => {
  await resetDb(db);
  await db.update(accounts).set({ providerId: PROVIDER_ACCOUNT_ID }).where(eq(accounts.id, SEED.accountId));
  fake = createFakeIncrease();
  await fund(50000);
});
afterAll(() => pool.end());

describe("outbound payment lifecycle through Increase webhooks and the worker", () => {
  it("$500 funded → $100 payment (500/400) → submitted → sent → settled: COMPLETED at 400/400", async () => {
    const { payment, transferId } = await submitted();
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });

    await fake.adapter.simulateTransferSubmission(transferId);
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);
    await fake.adapter.simulateTransferSettlement(transferId);
    const { event, outcomes } = await notify(transferId);
    expect(outcomes).toEqual(["processed"]);

    expect(await account()).toEqual({ ledgerCents: 40000, availableCents: 40000 });
    expect(await current(payment.id)).toMatchObject({ status: "COMPLETED", providerObjectId: transferId });
    expect(await transactionOf(payment.transactionId)).toMatchObject({ status: "COMPLETED", providerObjectId: transferId });
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect(await paymentEntries()).toMatchObject([{ transactionId: payment.transactionId, entryType: "PAYMENT_DEBIT", amountCents: -10000 }]);
    expect(await steps(payment.transactionId)).toEqual([
      ["HOLD_CREATED", null, "ACTIVE", 0, 50000, 40000],
      ["STATUS_CHANGED", null, "PENDING", 0, 50000, 40000],
      ["STATUS_CHANGED", "PENDING", "SUBMITTED", 0, 50000, 40000],
      ["SUBMITTED_TO_NETWORK", null, null, 0, 50000, 40000],
      // Ledger −100 with available unchanged: the hold had already reserved it.
      ["LEDGER_POSTED", null, null, -10000, 40000, 40000],
      ["HOLD_RELEASED", "ACTIVE", "RELEASED", 0, 40000, 40000],
      ["STATUS_CHANGED", "SUBMITTED", "COMPLETED", 0, 40000, 40000],
    ]);
    expect((await trace(payment.transactionId)).slice(2).every((t) => t.providerRef === transferId)).toBe(true);
    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored).toMatchObject({ status: "PROCESSED", transactionId: payment.transactionId });
  });

  it("a return before settlement: RETURNED, hold released, back to 500/500, no ledger entry", async () => {
    const { payment, transferId } = await submitted();
    await fake.adapter.simulateTransferSubmission(transferId);
    await fake.adapter.simulateTransferReturn(transferId, "account_closed");
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);

    const returnId = fake.achTransfers.get(transferId)!.return as { transaction_id: string };
    expect(await current(payment.id)).toMatchObject({ status: "RETURNED" });
    expect((await transactionOf(payment.transactionId)).status).toBe("RETURNED");
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect(await paymentEntries()).toHaveLength(0);
    expect((await trace(payment.transactionId)).slice(3).map((t) => [t.kind, t.toStatus, t.availableAfterCents, t.providerRef])).toEqual([
      ["SUBMITTED_TO_NETWORK", null, 40000, transferId],
      ["HOLD_RELEASED", "RELEASED", 50000, returnId.transaction_id],
      ["STATUS_CHANGED", "RETURNED", 50000, returnId.transaction_id],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a return after settlement: a new PAYMENT_RETURN +$100 linked to the payment, which stays COMPLETED", async () => {
    const { payment, transferId } = await submitted();
    await fake.adapter.simulateTransferSettlement(transferId);
    await notify(transferId);
    const completed = await transactionOf(payment.transactionId);

    await fake.adapter.simulateTransferReturn(transferId);
    const { event } = await notify(transferId);
    await notify(transferId);

    const returnId = (fake.achTransfers.get(transferId)!.return as { transaction_id: string }).transaction_id;
    const [returned] = await db.select().from(transactions).where(eq(transactions.type, "PAYMENT_RETURN"));
    expect(returned).toMatchObject({
      status: "COMPLETED",
      amountCents: 10000,
      provider: "increase",
      providerObjectId: transferId,
      relatedTransactionId: payment.transactionId,
      counterparty: "Globex Supplies",
    });
    expect(await transactionOf(payment.transactionId)).toEqual(completed);
    expect((await current(payment.id)).status).toBe("COMPLETED");
    expect((await paymentEntries()).map((e) => [e.transactionId, e.entryType, e.amountCents])).toEqual([
      [payment.transactionId, "PAYMENT_DEBIT", -10000],
      [returned.id, "PAYMENT_RETURN_CREDIT", 10000],
    ]);
    expect((await trace(returned.id)).map((t) => [t.kind, t.ledgerDeltaCents, t.toStatus, t.availableAfterCents, t.providerRef])).toEqual([
      ["LEDGER_POSTED", 10000, null, 50000, returnId],
      ["STATUS_CHANGED", 0, "COMPLETED", 50000, returnId],
    ]);
    const [stored] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, event.id));
    expect(stored.transactionId).toBe(returned.id);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a duplicate delivery, a later event for the same state and an older snapshot have no extra effect", async () => {
    const { payment, transferId } = await submitted();
    await fake.adapter.simulateTransferSettlement(transferId);
    const event = achTransferEvent(transferId);
    await deliver(event);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);
    const before = { trace: await trace(payment.transactionId), entries: await paymentEntries() };

    expect((await notify(transferId)).outcomes).toEqual(["processed"]);
    // An older snapshot: as Increase had it before submission.
    const now = fake.achTransfers.get(transferId)!;
    fake.achTransfers.set(transferId, { ...now, status: "pending_submission", submission: null, settlement: null });
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);

    expect(await trace(payment.transactionId)).toEqual(before.trace);
    expect(await paymentEntries()).toEqual(before.entries);
    expect(await account()).toEqual({ ledgerCents: 40000, availableCents: 40000 });
  });

  it("two workers processing created and updated at once apply each step once", async () => {
    const payment = await pay();
    const claim = await claimNextPayment(db, { leaseSeconds: 60 });
    await submitPayment(db, claim!, fake.adapter, logger);
    const transferId = (await current(payment.id)).providerObjectId!;
    await fake.adapter.simulateTransferSettlement(transferId);
    await deliver(achTransferEvent(transferId, "ach_transfer.created"));
    await deliver(achTransferEvent(transferId, "ach_transfer.updated"));
    const claimed = [await claimNextEvent(db, { leaseSeconds: 60 }), await claimNextEvent(db, { leaseSeconds: 60 })];
    expect(await Promise.all(claimed.map((event) => processEvent(db, event!, routing(), logger)))).toEqual(["processed", "processed"]);
    expect(await paymentEntries()).toHaveLength(1);
    expect((await trace(payment.transactionId)).map((t) => t.kind)).toEqual([
      "HOLD_CREATED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
      "SUBMITTED_TO_NETWORK",
      "LEDGER_POSTED",
      "HOLD_RELEASED",
      "STATUS_CHANGED",
    ]);
  });

  it("the webhook arrives before the submitter stored the id: linked by our idempotency key, then settled in order", async () => {
    const payment = await pay();
    // The submitter's call reached Increase but it crashed before recording the transfer.
    const sent = await fake.adapter.createTransfer({
      sourceAccountId: PROVIDER_ACCOUNT_ID,
      amountCents: 10000,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Globex Supplies",
      statementDescriptor: "Invoice 2468",
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });
    await fake.adapter.simulateTransferSettlement(sent.id);
    expect((await notify(sent.id)).outcomes).toEqual(["processed"]);

    expect(await current(payment.id)).toMatchObject({ status: "COMPLETED", providerObjectId: sent.id });
    expect((await trace(payment.transactionId)).slice(2).map((t) => [t.kind, t.toStatus])).toEqual([
      ["STATUS_CHANGED", "SUBMITTED"],
      ["SUBMITTED_TO_NETWORK", null],
      ["LEDGER_POSTED", null],
      ["HOLD_RELEASED", "RELEASED"],
      ["STATUS_CHANGED", "COMPLETED"],
    ]);
    // Nothing left for the submitter: the payment is no longer PENDING.
    expect(await claimNextPayment(db, { leaseSeconds: 60 })).toBeNull();
    expect(await account()).toEqual({ ledgerCents: 40000, availableCents: 40000 });
  });

  it("a rejected transfer fails the payment and releases the hold", async () => {
    const { payment, transferId } = await submitted();
    fake.achTransfers.get(transferId)!.status = "rejected";
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);
    expect(await current(payment.id)).toMatchObject({ status: "FAILED", lastSubmitError: "provider rejected the transfer" });
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect(await paymentEntries()).toHaveLength(0);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a transfer that isn't ours fails at once; one naming a payment that isn't there retries", async () => {
    const created = await fake.adapter.createTransfer({
      sourceAccountId: PROVIDER_ACCOUNT_ID,
      amountCents: 500,
      accountNumber: "11112222",
      routingNumber: "101050001",
      recipientName: "Dashboard transfer",
      statementDescriptor: "Manual",
      idempotencyKey: "made-in-the-dashboard",
    });
    expect((await notify(created.id)).outcomes).toEqual(["failed"]);
    const [notOurs] = await db.select().from(externalEvents);
    expect(notOurs.lastError).toBe(`PaymentNotOursError: increase transfer ${created.id} has no Trace payment idempotency key and matches no payment`);

    fake.achTransfers.get(created.id)!.idempotency_key = paymentIdempotencyKey(crypto.randomUUID());
    expect((await notify(created.id)).outcomes).toEqual(["retry"]);
  });

  /**
   * The submitter's last attempt reaches Increase, which creates the transfer, but the answer is
   * lost: the submitter gives up (PENDING, hold kept, not claimable). Returns the live transfer.
   */
  async function givenUp(): Promise<{ payment: Payment; transferId: string }> {
    const payment = await pay();
    await db.update(payments).set({ submitAttempts: MAX_SUBMIT_ATTEMPTS - 1 }).where(eq(payments.id, payment.id));
    fake = createFakeIncrease({ timeoutMs: 50 });
    fake.next = "succeed_then_hang";
    expect(await submitPayment(db, (await claimNextPayment(db, { leaseSeconds: 60 }))!, fake.adapter, logger)).toBe("gave_up");
    expect(await current(payment.id)).toMatchObject({ status: "PENDING", providerObjectId: null, submitGaveUpAt: expect.any(Date) });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
    const [transferId] = fake.achTransfers.keys();
    return { payment, transferId };
  }

  it("given up, then a webhook shows the transfer went out: linked by our key and completed (debit posted, hold released)", async () => {
    const { payment, transferId } = await givenUp();
    await fake.adapter.simulateTransferSettlement(transferId);
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);

    expect(await current(payment.id)).toMatchObject({ status: "COMPLETED", providerObjectId: transferId });
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect(await paymentEntries()).toMatchObject([{ transactionId: payment.transactionId, entryType: "PAYMENT_DEBIT", amountCents: -10000 }]);
    expect((await trace(payment.transactionId)).slice(2).map((t) => [t.kind, t.fromStatus, t.toStatus])).toEqual([
      ["STATUS_CHANGED", "PENDING", "PENDING"],
      ["STATUS_CHANGED", "PENDING", "SUBMITTED"],
      ["SUBMITTED_TO_NETWORK", null, null],
      ["LEDGER_POSTED", null, null],
      ["HOLD_RELEASED", "ACTIVE", "RELEASED"],
      ["STATUS_CHANGED", "SUBMITTED", "COMPLETED"],
    ]);
    expect(await account()).toEqual({ ledgerCents: 40000, availableCents: 40000 });
  });

  it("given up, then a webhook shows the transfer was canceled: FAILED with the hold released", async () => {
    const { payment, transferId } = await givenUp();
    fake.achTransfers.get(transferId)!.status = "canceled";
    expect((await notify(transferId)).outcomes).toEqual(["processed"]);
    expect(await current(payment.id)).toMatchObject({ status: "FAILED", lastSubmitError: "provider canceled the transfer" });
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect(await paymentEntries()).toHaveLength(0);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a live transfer for a payment Increase refused (FAILED, hold released) goes to Ops without touching money", async () => {
    const payment = await pay();
    fake.next = "invalid";
    expect(await submitPayment(db, (await claimNextPayment(db, { leaseSeconds: 60 }))!, fake.adapter, logger)).toBe("rejected");
    const sent = await fake.adapter.createTransfer({
      sourceAccountId: PROVIDER_ACCOUNT_ID,
      amountCents: 10000,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Globex Supplies",
      statementDescriptor: "Invoice 2468",
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });
    const before = await trace(payment.transactionId);

    expect((await notify(sent.id)).outcomes).toEqual(["failed"]);
    const [event] = await db.select().from(externalEvents);
    expect(event.lastError).toContain("the payment is FAILED but the provider has a live transfer for it");
    expect(await trace(payment.transactionId)).toEqual(before);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a transfer for a different amount than the payment is a permanent mismatch", async () => {
    const { payment, transferId } = await submitted();
    fake.achTransfers.get(transferId)!.amount = 9000;
    expect((await notify(transferId)).outcomes).toEqual(["failed"]);
    expect((await current(payment.id)).status).toBe("SUBMITTED");
  });
});
