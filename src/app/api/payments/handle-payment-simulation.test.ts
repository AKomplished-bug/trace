import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../db/client";
import { accounts, businesses, payments, transactionEvents, transactions } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { createTestDb, createTransaction, resetDb } from "../../../db/test-helpers";
import { INCREASE_IGNORED_EVENT_TYPES } from "../../../integrations/increase";
import { achTransferEvent, createFakeIncrease, signedIncreaseWebhook, type FakeIncrease } from "../../../integrations/increase/fake-increase";
import { sessionConfig } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { postLedgerEntry } from "../../../services/ledger";
import { createPayment, type Payment } from "../../../services/payments";
import { claimNextEvent, processEvent } from "../../../worker/events";
import { handlerKey } from "../../../worker/handlers";
import { increaseTransferHandlers } from "../../../worker/increase";
import { claimNextPayment, submitPayment } from "../../../worker/payment-submitter";
import { handleWebhook } from "../webhooks/handle-webhook";
import { handlePaymentSimulation, type PaymentSimulationAction } from "./handle-payment-simulation";

const { pool, db } = createTestDb(20);
let fake: FakeIncrease;
let cookie: string | undefined;

async function post(action: PaymentSimulationAction, paymentId: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const request = new Request(`http://localhost/api/payments/${paymentId}/${action}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await handlePaymentSimulation({ db, provider: fake.adapter, logger }, action, request, { id: paymentId });
  return { status: response.status, body: await response.json() };
}

async function pay(): Promise<Payment> {
  const input = { accountId: SEED.accountId, recipientName: "Globex Supplies", accountNumber: "987654321", routingNumber: "101050001", amountCents: 10000, description: null, idempotencyKey: crypto.randomUUID() };
  return (await createPayment(db, { name: "increase" }, input, logger)).payment;
}

async function submitted(): Promise<Payment> {
  const payment = await pay();
  await submitPayment(db, (await claimNextPayment(db, { leaseSeconds: 60 }))!, fake.adapter, logger);
  return (await db.select().from(payments).where(eq(payments.id, payment.id)))[0];
}

async function webhookAndWorker(transferId: string) {
  const { body, headers } = signedIncreaseWebhook(achTransferEvent(transferId));
  await handleWebhook({ db, webhookVerifiers: { increase: fake.adapter }, logger }, "increase", new Request("http://localhost/api/webhooks/increase", { method: "POST", body, headers }));
  const handlers = Object.fromEntries(Object.entries(increaseTransferHandlers(() => fake.adapter)).map(([type, h]) => [handlerKey("increase", type), h]));
  const event = await claimNextEvent(db, { leaseSeconds: 60 });
  expect(await processEvent(db, event!, { handlers, ignored: { increase: INCREASE_IGNORED_EVENT_TYPES } }, logger)).toBe("processed");
}

const stateCounts = async () => ({ transactions: await db.$count(transactions), trace: await db.$count(transactionEvents) });

beforeEach(async () => {
  await resetDb(db);
  await db.update(accounts).set({ providerId: "account_in71c4amph0vgo2qllky" }).where(eq(accounts.id, SEED.accountId));
  const funding = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents: 50000, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 }));
  fake = createFakeIncrease({ timeoutMs: 50 });
  cookie = `${SESSION_COOKIE}=${signSession(
    { userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionConfig().SESSION_SECRET,
  )}`;
});
afterAll(() => pool.end());

describe("POST /api/payments/:id/{submit,settle,return}", () => {
  it("settle → 202 with no state change; the payment completes only once the webhook is processed", async () => {
    const payment = await submitted();
    const before = await stateCounts();
    const response = await post("settle", payment.id);
    expect(response).toEqual({ status: 202, body: { requested: { paymentId: payment.id, action: "settle" }, achTransferId: payment.providerObjectId } });
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: `/simulations/ach_transfers/${payment.providerObjectId}/settle` });
    expect(await stateCounts()).toEqual(before);
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0].status).toBe("SUBMITTED");

    await webhookAndWorker(payment.providerObjectId!);
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0].status).toBe("COMPLETED");
  });

  it("submit and return pass the reason through", async () => {
    const payment = await submitted();
    expect((await post("submit", payment.id, {})).status).toBe(202);
    expect((await post("return", payment.id, { reason: "account_closed" })).status).toBe(202);
    expect(fake.requests.at(-1)).toMatchObject({ path: `/simulations/ach_transfers/${payment.providerObjectId}/return`, body: { reason: "account_closed" } });
    await webhookAndWorker(payment.providerObjectId!);
    expect((await db.select().from(payments).where(eq(payments.id, payment.id)))[0].status).toBe("RETURNED");
  });

  it("maps refusals: 404 missing or another account's, 409 not yet submitted, 422 Increase refuses, 502 timeout", async () => {
    const payment = await submitted();
    const pending = await pay();
    expect(await post("settle", crypto.randomUUID())).toMatchObject({ status: 404, body: { error: { code: "payment_not_found" } } });
    expect(await post("settle", pending.id)).toMatchObject({ status: 409, body: { error: { code: "payment_not_submitted" } } });

    const [other] = await db.insert(businesses).values({ name: "Other Co" }).returning();
    const [otherAccount] = await db.insert(accounts).values({ businessId: other.id }).returning();
    const otherTransaction = await createTransaction(db, { accountId: otherAccount.id, type: "OUTBOUND_PAYMENT", amountCents: 100 });
    const [otherPayment] = await db
      .insert(payments)
      .values({ accountId: otherAccount.id, transactionId: otherTransaction, recipient: "X", accountNumber: "11112222", routingNumber: "101050001", amountCents: 100, provider: "increase", providerObjectId: "ach_transfer_other" })
      .returning();
    expect((await post("settle", otherPayment.id)).status).toBe(404);
    expect(fake.requests.filter((r) => r.path.startsWith("/simulations"))).toHaveLength(0);

    // A return needs the transfer to be submitted first.
    expect(await post("return", payment.id)).toMatchObject({ status: 422, body: { error: { code: "provider_rejected" } } });
    fake.next = "hang";
    expect(await post("submit", payment.id)).toMatchObject({ status: 502, body: { error: { code: "provider_unavailable" } } });
  });

  it("checks auth first and validates the id and body", async () => {
    const payment = await submitted();
    cookie = undefined;
    expect((await post("settle", payment.id, "{not json")).status).toBe(401);
    cookie = `${SESSION_COOKIE}=${signSession({ userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET)}`;
    expect(await post("settle", "nope")).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await post("settle", payment.id, "{not json")).toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
    expect(await post("return", payment.id, { reason: "because" })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(fake.requests.filter((r) => r.path.startsWith("/simulations"))).toHaveLength(0);
  });
});
