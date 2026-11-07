import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, payments, reconciliationRecords, reconciliationRuns } from "../db/schema";
import { SEED } from "../db/seed";
import { createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { createFakeIncrease, type AchTransferJson } from "../integrations/increase/fake-increase";
import achPending from "../integrations/increase/fixtures/ach_transfer.pending_submission.json";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { withTransaction } from "../db/client";
import { accounts, cards, externalEvents, transactions } from "../db/schema";
import { createFakeStripe } from "../integrations/stripe/fake-stripe";
import succeededIntent from "../integrations/stripe/fixtures/payment_intent.succeeded.json";
import refundedFixture from "../integrations/increase/fixtures/card_payment.refunded.json";
import { seedCardPayment, type CardPaymentJson } from "../integrations/increase/fake-increase";
import { applyCardPayment } from "./cards";
import { postLedgerEntry } from "./ledger";
import { applyAchTransfer, createPayment } from "./payments";
import { DEMO, demoReconciliationSource, seedDemoStory } from "./demo";
import { flushCounters, readCounters } from "./metrics";
import { paymentIdempotencyKey } from "./payments";
import { claimNextRun, executeRun, requestRun, retryRun, RUN_AUDIT_ENTITY, type ReconciliationSources } from "./reconciliation";

const { pool, db } = createTestDb();
const window = () => ({ start: new Date(Date.now() - 24 * 3_600_000), end: new Date(Date.now() + 60_000) });
const request = (provider = "demo") => requestRun(db, { provider, window: window(), userId: SEED.opsUserId, correlationId: newId() });
const claim = (providers = ["demo"]) => claimNextRun(db, { leaseSeconds: 60, providers });

async function runOnce(sources: ReconciliationSources, providers = ["demo"], options = {}) {
  const run = await claim(providers);
  if (!run) throw new Error("expected a due run");
  return { run, outcome: await executeRun(db, run, sources, logger, options) };
}

async function runRow(id: string) {
  const [row] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id));
  return row;
}

const records = (runId: string) => db.select().from(reconciliationRecords).where(eq(reconciliationRecords.runId, runId));

const OUR_CARD = "card_ours";
const OUR_ACCOUNT = "account_ours";
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

/** Links the seeded card and account to Increase ids, as `npm run increase:bootstrap` would. */
async function linkProviderIds() {
  await db.update(cards).set({ providerId: OUR_CARD }).where(eq(cards.id, SEED.cardId));
  await db.update(accounts).set({ providerId: OUR_ACCOUNT }).where(eq(accounts.id, SEED.accountId));
}

async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

/** Applies a provider object through the worker's service, as its webhook's event would. */
async function applied(apply: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0], eventId: string) => Promise<void>) {
  const [event] = await db
    .insert(externalEvents)
    .values({ provider: "increase", externalEventId: `evt_${newId()}`, eventType: "test.applied", payload: {}, correlationId: newId() })
    .returning({ id: externalEvents.id });
  await withTransaction(db, (tx) => apply(tx, event.id));
}

const backdate = (id: string, at: Date) => db.update(transactions).set({ createdAt: at, updatedAt: at }).where(eq(transactions.id, id));

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
});
afterAll(() => pool.end());

describe("reconciliation run", () => {
  it("finds the demo's $65 vs $80 card settlement and matches the funding", async () => {
    await seedDemoStory(db, logger);
    const requested = await request();
    expect(requested.outcome).toBe("created");
    const { run, outcome } = await runOnce({ demo: await demoReconciliationSource(db) });
    expect(outcome).toBe("succeeded");
    expect(run.id).toBe(requested.run.id);

    expect(await runRow(run.id)).toMatchObject({ status: "SUCCEEDED", matchedCount: 1, exceptionCount: 1, lastError: null, attempts: 1 });
    const rows = await records(run.id);
    expect(rows.map((r) => [r.transactionType, r.status, r.reason, r.internalAmountCents, r.externalAmountCents, r.internalStatus, r.externalStatus])).toEqual(
      expect.arrayContaining([
        ["FUNDING", "MATCHED", null, 50000, 50000, "SETTLED", "SETTLED"],
        ["CARD_PURCHASE", "AMOUNT_MISMATCH", "amount", 6500, 8000, "SETTLED", "SETTLED"],
      ]),
    );
    const mismatch = rows.find((r) => r.status === "AMOUNT_MISMATCH")!;
    expect(mismatch).toMatchObject({
      transactionId: DEMO.purchaseTransactionId,
      accountId: SEED.accountId,
      externalId: "demo_card_payment_1",
      externalRef: "demo_settlement_1",
    });

    await flushCounters(db, logger);
    const counters = await readCounters(db);
    expect(counters).toEqual(
      expect.arrayContaining([
        { name: "reconciliation_results_total", labels: { provider: "demo", status: "MATCHED" }, value: 1 },
        { name: "reconciliation_results_total", labels: { provider: "demo", status: "AMOUNT_MISMATCH" }, value: 1 },
        { name: "reconciliation_runs_total", labels: { provider: "demo", outcome: "succeeded" }, value: 1 },
      ]),
    );
  });

  it("matches when the provider agrees with our settled amount", async () => {
    await seedDemoStory(db, logger);
    await request();
    const { run } = await runOnce({ demo: await demoReconciliationSource(db, { providerSettledCents: DEMO.settledCents }) });
    expect((await records(run.id)).map((r) => r.status)).toEqual(["MATCHED", "MATCHED"]);
  });

  it("is idempotent: a second request while one is active returns it and writes nothing", async () => {
    const first = await request();
    const second = await request();
    expect(second).toMatchObject({ outcome: "already_active", run: { id: first.run.id, status: "PENDING" } });
    expect(await db.select().from(reconciliationRuns)).toHaveLength(1);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityType, RUN_AUDIT_ENTITY));
    expect(audit).toHaveLength(1);
    // Other providers are independent.
    expect((await request("stripe")).outcome).toBe("created");
  });

  it("creates exactly one run for concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => request()));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(await db.select().from(reconciliationRuns)).toHaveLength(1);
  });

  it("lets a new run start once the previous one finished", async () => {
    await seedDemoStory(db, logger);
    const first = await request();
    await runOnce({ demo: await demoReconciliationSource(db) });
    const second = await request();
    expect(second.outcome).toBe("created");
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("only one worker claims a run while its lease holds", async () => {
    await request();
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await claim()).toBeNull();
    // A worker that only knows other providers never claims it.
    await db.update(reconciliationRuns).set({ status: "PENDING" });
    expect(await claim(["stripe"])).toBeNull();
  });

  it("a worker whose claim was taken over writes nothing", async () => {
    await seedDemoStory(db, logger);
    await request();
    const stale = await claim();
    // The lease expired and another worker claimed it.
    await db.update(reconciliationRuns).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const current = await claim();
    expect(current?.claimToken).toBe(2);
    expect(await executeRun(db, stale!, { demo: await demoReconciliationSource(db) }, logger)).toBe("lease_lost");
    expect(await records(stale!.id)).toHaveLength(0);
    expect(await runRow(stale!.id)).toMatchObject({ status: "RUNNING" });
    expect(await executeRun(db, current!, { demo: await demoReconciliationSource(db) }, logger)).toBe("succeeded");
  });

  it("a failed fetch marks the run FAILED with a sanitized error; Ops retry runs it again", async () => {
    await seedDemoStory(db, logger);
    const { run: requested } = await request();
    const failing = createFakeIncrease();
    failing.next = "error";
    const { outcome } = await runOnce({ demo: { cards: failing.adapter, scope: { cardIds: [OUR_CARD], accountIds: [] } } });
    expect(outcome).toBe("failed");
    const failed = await runRow(requested.id);
    expect(failed).toMatchObject({ status: "FAILED", lastError: "PaymentProviderError: Increase list card payments failed: internal_server_error" });
    expect(failed.lastError).not.toContain("Something went wrong");
    expect(failed.finishedAt).not.toBeNull();
    expect(await records(requested.id)).toHaveLength(0);
    // FAILED is not active: a new request may start another run, so retry the failed one first.
    const correlationId = newId();
    expect(await retryRun(db, { runId: requested.id, userId: SEED.opsUserId, correlationId })).toMatchObject({ outcome: "retried", run: { status: "PENDING", attempts: 0 } });
    expect(await retryRun(db, { runId: requested.id, userId: SEED.opsUserId, correlationId: newId() })).toEqual({ outcome: "not_retryable", status: "PENDING" });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, requested.id), eq(auditEvents.action, "reconciliation.retry")));
    expect(audit).toMatchObject({ correlationId, previousState: { status: "FAILED", attempts: 1, claimToken: 1 }, newState: { status: "PENDING", attempts: 0, claimToken: 2 } });

    const retried = await runOnce({ demo: await demoReconciliationSource(db) });
    expect(retried.outcome).toBe("succeeded");
    expect(await runRow(requested.id)).toMatchObject({ status: "SUCCEEDED", lastError: null, claimToken: 3 });
  });

  it("a fetch past its deadline fails the run", async () => {
    await request();
    const hanging = createFakeIncrease({ timeoutMs: 5_000 });
    hanging.next = "hang";
    const { outcome, run } = await runOnce({ demo: { cards: hanging.adapter, scope: { cardIds: [OUR_CARD], accountIds: [] } } }, ["demo"], { fetchTimeoutMs: 50 });
    expect(outcome).toBe("failed");
    expect((await runRow(run.id)).lastError).toBe("FetchTimeoutError: provider fetch timed out after 50 ms");
  });

  it("retry refuses while the provider has another active run, and for unknown runs", async () => {
    const { run } = await request();
    await db.update(reconciliationRuns).set({ status: "FAILED" }).where(eq(reconciliationRuns.id, run.id));
    await request();
    expect(await retryRun(db, { runId: run.id, userId: SEED.opsUserId, correlationId: newId() })).toEqual({ outcome: "already_active" });
    expect(await runRow(run.id)).toMatchObject({ status: "FAILED" });
    expect(await retryRun(db, { runId: newId(), userId: SEED.opsUserId, correlationId: newId() })).toEqual({ outcome: "not_found" });
  });

  it("fails a run whose provider has no source", async () => {
    await request("stripe");
    const { outcome, run } = await runOnce({}, ["stripe"]);
    expect(outcome).toBe("failed");
    expect((await runRow(run.id)).lastError).toBe("no reconciliation source for provider stripe");
  });

  it("matches a refund made days after its purchase: the purchase's card payment is retrieved by id", async () => {
    await linkProviderIds();
    await fund(10000);
    const fake = createFakeIncrease();
    const old = daysAgo(5).toISOString();
    const [auth, settlement, refund] = structuredClone(refundedFixture.elements) as Array<Record<string, unknown>>;
    for (const e of [auth, settlement]) e.created_at = old;
    refund.created_at = new Date().toISOString();
    const cardPayment = seedCardPayment(fake, { ...(structuredClone(refundedFixture) as CardPaymentJson), id: "card_payment_old", card_id: OUR_CARD, created_at: old, elements: [auth, settlement, refund] });
    const fetched = await fake.adapter.retrieveCardPayment(cardPayment.id);
    await applied((tx, eventId) => applyCardPayment(tx, { eventId, provider: "increase", cardPayment: fetched }, logger));
    const [purchase] = await db.select().from(transactions).where(eq(transactions.type, "CARD_PURCHASE"));
    await backdate(purchase.id, daysAgo(5));
    const [reversal] = await db.select().from(transactions).where(eq(transactions.type, "CARD_REVERSAL"));
    expect(reversal.relatedTransactionId).toBe(purchase.id);

    await request("increase");
    fake.requests.length = 0;
    const { run } = await runOnce({ increase: { cards: fake.adapter, transfers: fake.adapter } }, ["increase"]);
    expect(fake.requests.map((r) => r.path)).toEqual(expect.arrayContaining(["/card_payments", "/ach_transfers", "/card_payments/card_payment_old"]));
    const rows = await records(run.id);
    expect(rows.map((r) => [r.transactionType, r.status, r.transactionId, r.externalAmountCents])).toEqual([["CARD_REVERSAL", "MATCHED", reversal.id, 6500]]);
  });

  it("matches a return weeks after the payment completed: the transfer is retrieved by id", async () => {
    await linkProviderIds();
    await fund(50000);
    const fake = createFakeIncrease();
    const input = { accountId: SEED.accountId, recipientName: "Globex", accountNumber: "987654321", routingNumber: "101050001", amountCents: 10000, description: null, idempotencyKey: newId() };
    const { payment } = await createPayment(db, { name: "increase" }, input, logger);
    const created = await fake.adapter.createTransfer({
      sourceAccountId: OUR_ACCOUNT,
      amountCents: 10000,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Globex",
      statementDescriptor: "Invoice",
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });
    await fake.adapter.simulateTransferSettlement(created.id);
    await fake.adapter.simulateTransferReturn(created.id);
    const old = daysAgo(21).toISOString();
    const stored = fake.achTransfers.get(created.id)!;
    Object.assign(stored, { created_at: old });
    Object.assign(stored.submission as object, { submitted_at: old });
    Object.assign(stored.settlement as object, { settled_at: old });
    const transfer = await fake.adapter.retrieveTransfer(created.id);
    await applied((tx, eventId) => applyAchTransfer(tx, { eventId, provider: "increase", transfer }, logger));
    await backdate(payment.transactionId, daysAgo(21));
    const [paymentReturn] = await db.select().from(transactions).where(eq(transactions.type, "PAYMENT_RETURN"));

    await request("increase");
    const { run } = await runOnce({ increase: { cards: fake.adapter, transfers: fake.adapter } }, ["increase"]);
    const rows = await records(run.id);
    expect(rows.map((r) => [r.transactionType, r.status, r.transactionId, r.externalId])).toEqual([["PAYMENT_RETURN", "MATCHED", paymentReturn.id, created.id]]);
  });

  it("lists only our card's card payments and our account's transfers", async () => {
    await linkProviderIds();
    const fake = createFakeIncrease();
    const now = new Date().toISOString();
    seedCardPayment(fake, { ...(structuredClone(refundedFixture) as CardPaymentJson), id: "card_payment_theirs", card_id: "card_someone_else", created_at: now });
    await fake.adapter.createTransfer({
      sourceAccountId: "account_someone_else",
      amountCents: 500,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Someone",
      statementDescriptor: "Theirs",
      idempotencyKey: "theirs-1",
    });
    await request("increase");
    const { run, outcome } = await runOnce({ increase: { cards: fake.adapter, transfers: fake.adapter } }, ["increase"], { graceMs: 0 });
    expect(outcome).toBe("succeeded");
    expect(await records(run.id)).toEqual([]);
    expect(fake.requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual(["/card_payments", "/ach_transfers"]);
  });

  it("drops PaymentIntents without our transaction metadata and counts them", async () => {
    const stripe = createFakeStripe();
    const created = Math.floor(Date.now() / 1000) - 7200;
    const ours = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents: 50000, provider: "stripe", providerObjectId: "pi_ours", createdAt: new Date(created * 1000) });
    await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: ours, entryType: "FUNDING_CREDIT", amountCents: 50000, providerRef: "ch_ours" }));
    await db.update(transactions).set({ updatedAt: new Date(created * 1000) }).where(eq(transactions.id, ours));
    stripe.intents.set("pi_ours", { ...structuredClone(succeededIntent), id: "pi_ours", amount: 50000, amount_received: 50000, latest_charge: "ch_ours", created, metadata: { transaction_id: ours } });
    stripe.intents.set("pi_dashboard", { ...structuredClone(succeededIntent), id: "pi_dashboard", created, metadata: {} });
    stripe.intents.set("pi_other_app", { ...structuredClone(succeededIntent), id: "pi_other_app", created, metadata: { transaction_id: "order-42" } });
    await request("stripe");
    const { run } = await runOnce({ stripe: { payments: stripe.adapter } }, ["stripe"]);
    expect((await records(run.id)).map((r) => [r.status, r.externalId])).toEqual([["MATCHED", "pi_ours"]]);
    await flushCounters(db, logger);
    expect(await readCounters(db)).toEqual(expect.arrayContaining([{ name: "reconciliation_foreign_records_total", labels: { provider: "stripe" }, value: 2 }]));
  });

  it("pairs an ACH transfer with its payment through our idempotency key", async () => {
    await linkProviderIds();
    const transactionId = await createTransaction(db, { type: "OUTBOUND_PAYMENT", status: "PENDING", amountCents: 10000, provider: "increase" });
    const [payment] = await db
      .insert(payments)
      .values({ accountId: SEED.accountId, transactionId, recipient: "Globex", accountNumber: "987654321", routingNumber: "101050001", amountCents: 10000, provider: "increase" })
      .returning({ id: payments.id });
    const fake = createFakeIncrease();
    const transfer: AchTransferJson = {
      ...structuredClone(achPending),
      id: "ach_transfer_1",
      status: "pending_submission",
      amount: 10000,
      idempotency_key: paymentIdempotencyKey(payment.id),
      account_id: OUR_ACCOUNT,
      created_at: new Date().toISOString(),
    };
    fake.achTransfers.set(transfer.id, transfer);
    await request("increase");
    const sources = { increase: { cards: fake.adapter, transfers: fake.adapter } };

    const pending = await runOnce(sources, ["increase"]);
    const [within] = await records(pending.run.id);
    expect(within).toMatchObject({ status: "PENDING_EXTERNAL", reason: "within_grace", transactionId, externalId: "ach_transfer_1", internalStatus: "PENDING", externalStatus: "SUBMITTED" });

    await request("increase");
    const late = await runOnce(sources, ["increase"], { graceMs: 0 });
    const [mismatch] = await records(late.run.id);
    expect(mismatch).toMatchObject({ status: "STATUS_MISMATCH", reason: "status", transactionId });
  });
});
