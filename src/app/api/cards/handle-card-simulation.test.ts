import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { accounts, businesses, cards, externalEvents, transactionEvents, transactions } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { createTestDb, createTransaction, resetDb } from "../../../db/test-helpers";
import { INCREASE_IGNORED_EVENT_TYPES } from "../../../integrations/increase";
import { cardPaymentEvent, createFakeIncrease, signedIncreaseWebhook, type FakeIncrease } from "../../../integrations/increase/fake-increase";
import { sessionConfig } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { claimNextEvent, processEvent } from "../../../worker/events";
import { handlerKey } from "../../../worker/handlers";
import { increaseHandlers } from "../../../worker/increase";
import { handleWebhook } from "../webhooks/handle-webhook";
import { handleCardSimulation, type CardSimulationAction } from "./handle-card-simulation";

const { pool, db } = createTestDb(20);
const PROVIDER_CARD_ID = "card_oubs0hwk5rn6knuecxg2";
let fake: FakeIncrease;
let cookie: string | undefined;

function signIn(role: "OWNER" | "OPS" = "OWNER") {
  const token = signSession(
    { userId: role === "OWNER" ? SEED.ownerUserId : SEED.opsUserId, role, accountId: role === "OWNER" ? SEED.accountId : null, expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionConfig().SESSION_SECRET,
  );
  cookie = `${SESSION_COOKIE}=${token}`;
}

async function post(action: CardSimulationAction, body: unknown, cardId: string = SEED.cardId) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const request = new Request(`http://localhost/api/cards/${cardId}/${action}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await handleCardSimulation({ db, provider: fake.adapter, logger }, action, request, { id: cardId });
  return { status: response.status, body: await response.json() };
}

/** Delivers Increase's webhook for the card payment and runs the worker once. */
async function webhookAndWorker(cardPaymentId: string) {
  const { body, headers } = signedIncreaseWebhook(cardPaymentEvent(cardPaymentId));
  await handleWebhook({ db, webhookVerifiers: { increase: fake.adapter }, logger }, "increase", new Request("http://localhost/api/webhooks/increase", { method: "POST", body, headers }));
  const handlers = Object.fromEntries(Object.entries(increaseHandlers(() => fake.adapter)).map(([type, h]) => [handlerKey("increase", type), h]));
  const event = await claimNextEvent(db, { leaseSeconds: 60 });
  expect(await processEvent(db, event!, { handlers, ignored: { increase: INCREASE_IGNORED_EVENT_TYPES } }, logger)).toBe("processed");
}

const stateCounts = async () => ({
  transactions: await db.$count(transactions),
  trace: await db.$count(transactionEvents),
  events: await db.$count(externalEvents),
});

beforeEach(async () => {
  await resetDb(db);
  await db.update(cards).set({ providerId: PROVIDER_CARD_ID }).where(eq(cards.id, SEED.cardId));
  fake = createFakeIncrease({ timeoutMs: 50 });
  signIn();
});
afterAll(() => pool.end());

describe("POST /api/cards/:id/{authorize,settle,reverse,expire}", () => {
  it("authorize → 202 with no state change; the purchase appears only once the webhook is processed", async () => {
    const response = await post("authorize", { amountCents: 8000, merchant: "FIGMA.COM" });
    expect(response).toEqual({
      status: 202,
      body: {
        requested: { cardId: SEED.cardId, action: "authorize", amountCents: 8000, merchant: "FIGMA.COM" },
        cardPaymentId: expect.stringMatching(/^card_payment_fake_/),
        declined: false,
      },
    });
    expect(fake.requests).toMatchObject([{ path: "/simulations/card_authorizations", body: { card_id: PROVIDER_CARD_ID, amount: 8000, merchant_descriptor: "FIGMA.COM" } }]);
    expect(await db.$count(transactions)).toBe(0);

    await webhookAndWorker(response.body.cardPaymentId);
    const [purchase] = await db.select().from(transactions);
    expect(purchase).toMatchObject({ type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents: 8000, counterparty: "FIGMA.COM" });

    const settle = await post("settle", { transactionId: purchase.id, amountCents: 6500 });
    expect(settle).toMatchObject({ status: 202, body: { requested: { action: "settle", transactionId: purchase.id, amountCents: 6500 } } });
    expect(fake.requests.at(-1)).toMatchObject({ path: "/simulations/card_settlements", body: { card_id: PROVIDER_CARD_ID, amount: 6500 } });
    expect((await db.select().from(transactions))[0].status).toBe("AUTHORIZED");
    await webhookAndWorker(response.body.cardPaymentId);
    expect((await db.select().from(transactions))[0].status).toBe("SETTLED");

    expect((await post("reverse", { transactionId: purchase.id, amountCents: 2000 })).status).toBe(202);
    expect(fake.requests.at(-1)).toMatchObject({ path: "/simulations/card_refunds", body: { amount: 2000 } });
  });

  it("reverse before settlement voids, and expire expires, by the purchase's card payment", async () => {
    const { body } = await post("authorize", { amountCents: 8000 });
    await webhookAndWorker(body.cardPaymentId);
    const [purchase] = await db.select().from(transactions);
    expect((await post("reverse", { transactionId: purchase.id })).status).toBe(202);
    expect(fake.requests.at(-1)).toEqual({ method: "POST", path: "/simulations/card_reversals", body: { card_payment_id: body.cardPaymentId } });
    expect((await post("expire", { transactionId: purchase.id })).status).toBe(202);
    expect(fake.requests.at(-1)).toEqual({ method: "POST", path: "/simulations/card_authorization_expirations", body: { card_payment_id: body.cardPaymentId } });
  });

  it("refuses a partial reversal before settlement with 422, sending nothing; after settlement a partial refund goes through", async () => {
    const { body } = await post("authorize", { amountCents: 8000 });
    await webhookAndWorker(body.cardPaymentId);
    const [purchase] = await db.select().from(transactions);
    const sent = fake.requests.length;
    expect(await post("reverse", { transactionId: purchase.id, amountCents: 3000 })).toEqual({
      status: 422,
      body: { error: { code: "partial_reversal_not_supported", message: "Partial authorization reversals aren't supported; omit amountCents to void in full" } },
    });
    expect(fake.requests.slice(sent).map((r) => r.path)).toEqual([`/card_payments/${body.cardPaymentId}`]);

    await post("settle", { transactionId: purchase.id, amountCents: 6500 });
    await webhookAndWorker(body.cardPaymentId);
    expect((await post("reverse", { transactionId: purchase.id, amountCents: 3000 })).status).toBe(202);
    expect(fake.requests.at(-1)).toMatchObject({ path: "/simulations/card_refunds", body: { amount: 3000 } });
    await webhookAndWorker(body.cardPaymentId);
    const refund = await db.select().from(transactions).where(eq(transactions.type, "CARD_REVERSAL"));
    expect(refund).toMatchObject([{ amountCents: 3000, relatedTransactionId: purchase.id }]);
  });

  it("404s a purchase made on a different card of the same account, sending no simulation", async () => {
    const { body } = await post("authorize", { amountCents: 8000 });
    await webhookAndWorker(body.cardPaymentId);
    const [purchase] = await db.select().from(transactions);
    const otherCard = "00000000-0000-4000-8000-0000000000c1";
    await db.insert(cards).values({ id: otherCard, accountId: SEED.accountId, last4: "2222", providerId: "card_second" });
    const sent = fake.requests.length;
    for (const [action, request] of [
      ["settle", { transactionId: purchase.id, amountCents: 6500 }],
      ["reverse", { transactionId: purchase.id }],
      ["expire", { transactionId: purchase.id }],
    ] as const) {
      expect(await post(action, request, otherCard)).toEqual({ status: 404, body: { error: { code: "transaction_not_found", message: "No purchase with that id on this card" } } });
    }
    expect(fake.requests.slice(sent).every((r) => r.method === "GET")).toBe(true);
  });

  it("checks auth before anything else", async () => {
    cookie = undefined;
    expect(await post("authorize", "{not json", "not-a-uuid")).toEqual({ status: 401, body: { error: { code: "unauthenticated", message: "Sign in to continue" } } });
    signIn("OPS");
    expect((await post("authorize", { amountCents: 8000 })).status).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it("validates the card id and body with useful messages", async () => {
    const cases: Array<[CardSimulationAction, unknown, string, string]> = [
      ["authorize", { amountCents: 8000 }, "nope", "id: must be a card id"],
      ["authorize", "{not json", SEED.cardId, "Request body must be JSON"],
      ["authorize", {}, SEED.cardId, "amountCents: must be a number of cents"],
      ["authorize", { amountCents: 0 }, SEED.cardId, "amountCents: must be positive"],
      ["authorize", { amountCents: 10.5 }, SEED.cardId, "amountCents: must be whole cents"],
      ["authorize", { amountCents: 8000, merchant: "" }, SEED.cardId, "merchant: must not be empty"],
      ["settle", { amountCents: 6500 }, SEED.cardId, "transactionId: must be a transaction id"],
      ["settle", { transactionId: SEED.cardId }, SEED.cardId, "amountCents: must be a number of cents"],
      ["reverse", { transactionId: "x" }, SEED.cardId, "transactionId: must be a transaction id"],
      ["expire", {}, SEED.cardId, "transactionId: must be a transaction id"],
    ];
    for (const [action, body, cardId, message] of cases) {
      const response = await post(action, body, cardId);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.message).toBe(message);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("404s another account's card or a non-card transaction, 409s an unlinked card", async () => {
    const otherBusiness = "00000000-0000-4000-8000-0000000000b1";
    const otherAccount = "00000000-0000-4000-8000-0000000000b2";
    const otherCard = "00000000-0000-4000-8000-0000000000b3";
    await db.insert(businesses).values({ id: otherBusiness, name: "Other Co." });
    await db.insert(accounts).values({ id: otherAccount, businessId: otherBusiness });
    await db.insert(cards).values({ id: otherCard, accountId: otherAccount, last4: "1111", providerId: "card_other" });
    expect((await post("authorize", { amountCents: 8000 }, otherCard)).body.error.code).toBe("card_not_found");

    const funding = await createTransaction(db, { type: "FUNDING", amountCents: 100 });
    expect((await post("expire", { transactionId: funding })).body.error.code).toBe("transaction_not_found");

    await db.update(cards).set({ providerId: null }).where(eq(cards.id, SEED.cardId));
    expect(await post("authorize", { amountCents: 8000 })).toMatchObject({ status: 409, body: { error: { code: "card_not_linked" } } });
    expect(fake.requests).toHaveLength(0);
  });

  it("an Increase timeout is a 502 with no state change; a refusal is a 422", async () => {
    const before = await stateCounts();
    fake.next = "hang";
    const timedOut = await post("authorize", { amountCents: 8000 });
    expect(timedOut.status).toBe(502);
    expect(timedOut.body.error.code).toBe("provider_unavailable");
    expect(JSON.stringify(timedOut.body)).not.toMatch(/stack|APIConnection|at \w+ \(/);
    expect(fake.requests).toHaveLength(1);
    expect(await stateCounts()).toEqual(before);

    fake.next = "reject";
    expect(await post("authorize", { amountCents: 8000 })).toMatchObject({ status: 422, body: { error: { code: "provider_rejected" } } });
    expect(await stateCounts()).toEqual(before);
  });
});
