import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../app/api/webhooks/handle-webhook";
import { withTransaction } from "../db/client";
import { eventDeliveries, externalEvents, ledgerEntries, transactionEvents, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { createFakeStripe, seedIntent, signedWebhook, type FakeStripe } from "../integrations/stripe/fake-stripe";
import chargeSucceeded from "../integrations/stripe/fixtures/event.charge.succeeded.json";
import paymentFailedEvent from "../integrations/stripe/fixtures/event.payment_intent.payment_failed.json";
import paymentSucceededEvent from "../integrations/stripe/fixtures/event.payment_intent.succeeded.json";
import succeededIntent from "../integrations/stripe/fixtures/payment_intent.succeeded.json";
import { STRIPE_IGNORED_EVENT_TYPES } from "../integrations/stripe";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "../services/accounts";
import { createFunding, FundingProviderError } from "../services/funding";
import { claimNextEvent, processEvent, type ProcessOutcome } from "./events";
import { handlerKey, type EventRouting } from "./handlers";
import { stripeHandlers } from "./stripe";

const { pool, db } = createTestDb(20);
let fake: FakeStripe;

function routing(): EventRouting {
  const handlers = Object.fromEntries(
    Object.entries(stripeHandlers(() => fake.adapter)).map(([type, handler]) => [handlerKey("stripe", type), handler]),
  );
  return { handlers, ignored: { stripe: STRIPE_IGNORED_EVENT_TYPES } };
}

/** Runs the worker until no event is due; returns each outcome. */
async function drain(): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  for (let event = await claimNextEvent(db, { leaseSeconds: 60 }); event; event = await claimNextEvent(db, { leaseSeconds: 60 })) {
    outcomes.push(await processEvent(db, event, routing(), logger));
  }
  return outcomes;
}

/** A Stripe event for `intentId` as Stripe would send it now: the fake's current PaymentIntent. */
function stripeEvent(template: typeof paymentSucceededEvent | typeof paymentFailedEvent, intentId: string, id = `evt_${newId()}`) {
  return { ...structuredClone(template), id, data: { object: fake.intents.get(intentId) } };
}

async function deliver(payload: unknown) {
  const { body, signature } = signedWebhook(payload);
  const request = new Request("http://localhost/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature } });
  const response = await handleWebhook({ db, webhookVerifiers: { stripe: fake.adapter }, logger }, "stripe", request);
  expect(response.status).toBe(200);
}

function fund(amountCents: number, idempotencyKey = newId()) {
  return createFunding(db, fake.adapter, { accountId: SEED.accountId, amountCents, idempotencyKey }, logger);
}

async function account() {
  const { cachedCents, ledgerSumCents } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  const availableCents = await withTransaction(db, async (tx) =>
    accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents),
  );
  return { ledgerCents: cachedCents, availableCents };
}

async function transaction(id: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

async function eventRow(externalEventId: string) {
  const [row] = await db.select().from(externalEvents).where(eq(externalEvents.externalEventId, externalEventId));
  return row;
}

/** Makes RETRY events due again, as if the backoff had passed. */
async function skipBackoff() {
  await db.update(externalEvents).set({ nextAttemptAt: sql`now()` }).where(eq(externalEvents.status, "RETRY"));
}

beforeEach(async () => {
  await resetDb(db);
  fake = createFakeStripe();
});
afterAll(() => pool.end());

describe("Stripe funding through webhook ingestion and the worker", () => {
  it("funds $500: SETTLED, ledger +500, balance 500/500, trace and linked event", async () => {
    const { transaction: created } = await fund(50000);
    expect(created).toMatchObject({ status: "PENDING", provider: "stripe" });
    const intentId = created.providerObjectId!;
    const event = stripeEvent(paymentSucceededEvent, intentId);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);

    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
    expect((await transaction(created.id)).status).toBe("SETTLED");
    const stored = await eventRow(event.id);
    expect(stored).toMatchObject({ status: "PROCESSED", transactionId: created.id });
    const entries = await db.select().from(ledgerEntries);
    expect(entries).toMatchObject([{ transactionId: created.id, entryType: "FUNDING_CREDIT", amountCents: 50000, externalEventId: stored.id }]);

    const trace = await db.select().from(transactionEvents).orderBy(asc(transactionEvents.accountSeq));
    const chargeId = fake.intents.get(intentId)!.latest_charge;
    expect(trace).toMatchObject([
      { seq: 1, kind: "STATUS_CHANGED", fromStatus: null, toStatus: "PENDING", ledgerBalanceAfterCents: 0, availableAfterCents: 0 },
      { seq: 2, kind: "LEDGER_POSTED", ledgerDeltaCents: 50000, ledgerBalanceAfterCents: 50000, availableAfterCents: 50000, providerRef: chargeId, externalEventId: stored.id },
      { seq: 3, kind: "STATUS_CHANGED", fromStatus: "PENDING", toStatus: "SETTLED", ledgerBalanceAfterCents: 50000, availableAfterCents: 50000, providerRef: chargeId },
    ]);
  });

  it("a duplicate delivery is one event, two deliveries and one ledger entry", async () => {
    const { transaction: created } = await fund(50000);
    const event = stripeEvent(paymentSucceededEvent, created.providerObjectId!);
    await deliver(event);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);
    await deliver(event);
    expect(await drain()).toEqual([]);

    expect(await db.$count(externalEvents)).toBe(1);
    expect((await db.select().from(eventDeliveries)).map((d) => d.isDuplicate).sort()).toEqual([false, true, true]);
    expect(await db.$count(ledgerEntries)).toBe(1);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("a second event for an already settled PaymentIntent has no effect", async () => {
    const { transaction: created } = await fund(50000);
    await deliver(stripeEvent(paymentSucceededEvent, created.providerObjectId!));
    await deliver(stripeEvent(paymentSucceededEvent, created.providerObjectId!));
    expect(await drain()).toEqual(["processed", "processed"]);
    expect(await db.$count(ledgerEntries)).toBe(1);
    expect(await db.$count(transactionEvents)).toBe(3);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("trusts the fetched PaymentIntent: an amount mismatch posts nothing and fails to Ops at once", async () => {
    const { transaction: created } = await fund(50000);
    const intentId = created.providerObjectId!;
    const event = stripeEvent(paymentSucceededEvent, intentId);
    fake.intents.get(intentId)!.amount_received = 45000;
    await deliver(event);
    expect(await drain()).toEqual(["failed"]);

    const stored = await eventRow(event.id);
    expect(stored).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(stored.lastError).toMatch(/^FundingOutcomeMismatchError: .* received 45000 cents, .* expects 50000/);
    expect((await transaction(created.id)).status).toBe("PENDING");
    expect(await db.$count(ledgerEntries)).toBe(0);
    expect(await db.$count(transactionEvents)).toBe(1);
    expect(await account()).toEqual({ ledgerCents: 0, availableCents: 0 });
  });

  it("does not settle when the webhook says succeeded but Stripe doesn't", async () => {
    const { transaction: created } = await fund(50000);
    const intentId = created.providerObjectId!;
    const event = stripeEvent(paymentSucceededEvent, intentId);
    Object.assign(fake.intents.get(intentId)!, { status: "processing", amount_received: 0 });
    await deliver(event);
    expect(await drain()).toEqual(["retry"]);
    expect((await eventRow(event.id)).lastError).toContain("reports payment");
    expect(await account()).toEqual({ ledgerCents: 0, availableCents: 0 });
  });

  it("payment_failed moves the transaction to FAILED with a trace row and no ledger entry", async () => {
    fake.nextCreate = "decline";
    const { transaction: created } = await fund(50000);
    expect(created).toMatchObject({ status: "PENDING" });
    const event = stripeEvent(paymentFailedEvent, created.providerObjectId!);
    await deliver(event);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);

    expect((await transaction(created.id)).status).toBe("FAILED");
    expect(await eventRow(event.id)).toMatchObject({ status: "PROCESSED", transactionId: created.id });
    expect(await db.$count(ledgerEntries)).toBe(0);
    const trace = await db.select().from(transactionEvents).orderBy(asc(transactionEvents.accountSeq));
    expect(trace.map((t) => [t.kind, t.fromStatus, t.toStatus, t.ledgerDeltaCents])).toEqual([
      ["STATUS_CHANGED", null, "PENDING", 0],
      ["STATUS_CHANGED", "PENDING", "FAILED", 0],
    ]);
    expect(await account()).toEqual({ ledgerCents: 0, availableCents: 0 });
  });

  it("ignores a payment_failed whose PaymentIntent has since succeeded", async () => {
    const { transaction: created } = await fund(50000);
    await deliver(stripeEvent(paymentFailedEvent, created.providerObjectId!));
    expect(await drain()).toEqual(["processed"]);
    expect((await transaction(created.id)).status).toBe("PENDING");
    expect(await db.$count(transactionEvents)).toBe(1);
  });

  it("credits a funding whose Stripe call timed out after Stripe charged, via the PaymentIntent metadata", async () => {
    fake = Object.assign(createFakeStripe({ timeoutMs: 50 }), { nextCreate: "hang_after_create" as const });
    await expect(fund(50000)).rejects.toThrow(FundingProviderError);
    const [pending] = await db.select().from(transactions);
    expect(pending).toMatchObject({ status: "PENDING", providerObjectId: null });
    const [intent] = fake.intents.values();
    expect(intent.metadata).toMatchObject({ transaction_id: pending.id });

    const event = stripeEvent(paymentSucceededEvent, intent.id);
    await deliver(event);
    expect(await drain()).toEqual(["processed"]);
    expect(await transaction(pending.id)).toMatchObject({ status: "SETTLED", providerObjectId: intent.id });
    expect(await eventRow(event.id)).toMatchObject({ status: "PROCESSED", transactionId: pending.id });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });

    // The client's late retry with the same key now just returns the settled transaction.
    const replay = await fund(50000, pending.idempotencyKey!);
    expect(replay).toMatchObject({ replayed: true, transaction: { status: "SETTLED", providerObjectId: intent.id } });
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("credits a funding whose PaymentIntent id write failed, via the metadata", async () => {
    const { transaction: created } = await fund(50000);
    const intentId = created.providerObjectId!;
    // Same state as a failed UPDATE after Stripe answered: the PaymentIntent exists, our row has no id.
    await db.update(transactions).set({ providerObjectId: null }).where(eq(transactions.id, created.id));
    await deliver(stripeEvent(paymentSucceededEvent, intentId));
    expect(await drain()).toEqual(["processed"]);
    expect(await transaction(created.id)).toMatchObject({ status: "SETTLED", providerObjectId: intentId });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
  });

  it("fails to Ops at once when a second PaymentIntent names a transaction that tracks another", async () => {
    const { transaction: created } = await fund(50000);
    // E.g. a retry after Stripe's 24 h idempotency window created a second PaymentIntent.
    const second = seedIntent(fake, { ...structuredClone(succeededIntent), id: "pi_second", metadata: { transaction_id: created.id } });
    const event = stripeEvent(paymentSucceededEvent, second.id);
    await deliver(event);
    expect(await drain()).toEqual(["failed"]);
    expect(await eventRow(event.id)).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: `FundingOutcomeMismatchError: transaction ${created.id} tracks payment ${created.providerObjectId}, not pi_second`,
    });
    expect(await transaction(created.id)).toMatchObject({ status: "PENDING", providerObjectId: created.providerObjectId });
    expect(await db.$count(ledgerEntries)).toBe(0);
  });

  it("fails to Ops at once for a PaymentIntent without our metadata", async () => {
    const foreign = seedIntent(fake, { ...structuredClone(succeededIntent), id: "pi_dashboard", metadata: {} });
    const event = stripeEvent(paymentSucceededEvent, foreign.id);
    await deliver(event);
    expect(await drain()).toEqual(["failed"]);
    expect(await eventRow(event.id)).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "FundingNotOursError: stripe payment pi_dashboard has no Trace transaction_id metadata and matches no FUNDING transaction",
    });
  });

  it("fails to Ops at once on a currency mismatch", async () => {
    const { transaction: created } = await fund(50000);
    fake.intents.get(created.providerObjectId!)!.currency = "eur";
    await deliver(stripeEvent(paymentSucceededEvent, created.providerObjectId!));
    expect(await drain()).toEqual(["failed"]);
    expect(await db.$count(ledgerEntries)).toBe(0);
  });

  it("retries while the transaction named in the metadata isn't there yet", async () => {
    const missing = newId();
    const intent = seedIntent(fake, { ...structuredClone(succeededIntent), metadata: { transaction_id: missing } });
    const event = stripeEvent(paymentSucceededEvent, intent.id);
    await deliver(event);
    expect(await drain()).toEqual(["retry"]);
    expect((await eventRow(event.id)).lastError).toBe(`FundingNotFoundError: No FUNDING transaction ${missing} for stripe payment ${intent.id}`);

    const transactionId = await createTransaction(db, { id: missing, type: "FUNDING", amountCents: 50000, provider: "stripe" });
    await skipBackoff();
    expect(await drain()).toEqual(["processed"]);
    expect(await transaction(transactionId)).toMatchObject({ status: "SETTLED", providerObjectId: intent.id });
  });

  it("marks listed irrelevant Stripe events IGNORED", async () => {
    await deliver(chargeSucceeded);
    expect(await drain()).toEqual(["ignored"]);
    expect((await eventRow(chargeSucceeded.id)).status).toBe("IGNORED");
  });
});
