import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../db/client";
import { transactionEvents, transactions } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { balances, createTestDb, resetDb } from "../../../db/test-helpers";
import { STRIPE_IGNORED_EVENT_TYPES } from "../../../integrations/stripe";
import { createFakeStripe, signedWebhook, type FakeStripe } from "../../../integrations/stripe/fake-stripe";
import paymentSucceededEvent from "../../../integrations/stripe/fixtures/event.payment_intent.succeeded.json";
import { sessionConfig } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { accountAvailableCents, lockAccount } from "../../../services/accounts";
import { providerIdempotencyKey } from "../../../services/funding";
import { claimNextEvent, processEvent } from "../../../worker/events";
import { handlerKey } from "../../../worker/handlers";
import { stripeHandlers } from "../../../worker/stripe";
import { handleWebhook } from "../webhooks/handle-webhook";
import { handleFunding } from "./handle-funding";

const { pool, db } = createTestDb(20);
let fake: FakeStripe;

// A signed session for the seeded owner; tests that need a refusal send no cookie.
let cookie: string | undefined;
const ownerCookie = () =>
  `${SESSION_COOKIE}=${signSession(
    { userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionConfig().SESSION_SECRET,
  )}`;

function post(body: unknown, idempotencyKey: string | null = "key-1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  const request = new Request("http://localhost/api/funding", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleFunding({ db, provider: fake.adapter, logger }, request);
}

async function fundingRows() {
  return db.select().from(transactions).where(eq(transactions.type, "FUNDING"));
}

const creates = () => fake.requests.filter((r) => r.method === "POST");

beforeEach(async () => {
  cookie = ownerCookie();
  await resetDb(db);
  fake = createFakeStripe({ timeoutMs: 50 });
});
afterAll(() => pool.end());

describe("POST /api/funding", () => {
  it("funds $500 end to end: 201 PENDING, Stripe webhook, worker, balance 500/500", async () => {
    const response = await post({ amountCents: 50000 });
    expect(response.status).toBe(201);
    const { transaction } = await response.json();
    expect(transaction).toMatchObject({ type: "FUNDING", status: "PENDING", amountCents: 50000, currency: "USD", provider: "stripe" });
    expect(transaction.providerObjectId).toMatch(/^pi_fake_/);
    expect(creates()[0].idempotencyKey).toBe(providerIdempotencyKey(transaction.id));

    const event = { ...structuredClone(paymentSucceededEvent), data: { object: fake.intents.get(transaction.providerObjectId) } };
    const { body, signature } = signedWebhook(event);
    const webhook = new Request("http://localhost/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature } });
    expect((await handleWebhook({ db, webhookVerifiers: { stripe: fake.adapter }, logger }, "stripe", webhook)).status).toBe(200);

    const handlers = Object.fromEntries(Object.entries(stripeHandlers(() => fake.adapter)).map(([t, h]) => [handlerKey("stripe", t), h]));
    const claimed = await claimNextEvent(db, { leaseSeconds: 60 });
    expect(await processEvent(db, claimed!, { handlers, ignored: { stripe: STRIPE_IGNORED_EVENT_TYPES } }, logger)).toBe("processed");

    const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
    expect(replayMatches).toBe(true);
    const available = await withTransaction(db, async (tx) => accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents));
    expect([cachedCents, ledgerSumCents, available]).toEqual([50000, 50000, 50000]);
    const trace = await db.select().from(transactionEvents).orderBy(asc(transactionEvents.accountSeq));
    expect(trace.map((t) => [t.kind, t.toStatus, t.ledgerBalanceAfterCents, t.availableAfterCents])).toEqual([
      ["STATUS_CHANGED", "PENDING", 0, 0],
      ["LEDGER_POSTED", null, 50000, 50000],
      ["STATUS_CHANGED", "SETTLED", 50000, 50000],
    ]);
  });

  it("returns the same transaction for the same key and body, calling Stripe once", async () => {
    const first = await post({ amountCents: 50000 });
    const second = await post({ amountCents: 50000 });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(await fundingRows()).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    expect(await db.$count(transactionEvents)).toBe(1);
  });

  it("creates one transaction when the same key races itself", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => post({ amountCents: 50000 })));
    expect(responses.map((r) => r.status)).toEqual(Array(5).fill(201));
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).transaction.id)));
    expect(ids.size).toBe(1);
    const [row] = await fundingRows();
    expect(row.providerObjectId).toMatch(/^pi_fake_/);
    expect(await fundingRows()).toHaveLength(1);
  });

  it("rejects the same key with a different body with 409", async () => {
    await post({ amountCents: 50000 });
    const response = await post({ amountCents: 60000 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "idempotency_conflict", message: "This Idempotency-Key was already used with a different request body" },
    });
    expect(await fundingRows()).toHaveLength(1);
    expect(creates()).toHaveLength(1);
  });

  it("keeps the transaction PENDING when Stripe times out; a retry with the same key completes it", async () => {
    fake.nextCreate = "hang";
    const failed = await post({ amountCents: 50000 });
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "provider_unavailable",
        message: "The funding request is saved as pending, but the payment provider could not be reached. Retry with the same Idempotency-Key.",
      },
    });
    expect(text).not.toMatch(/at \w+ \(|Stripe|stack/i);
    const [pending] = await fundingRows();
    expect(pending).toMatchObject({ status: "PENDING", providerObjectId: null });

    const retried = await post({ amountCents: 50000 });
    expect(retried.status).toBe(201);
    expect((await retried.json()).transaction).toMatchObject({ id: pending.id, status: "PENDING", providerObjectId: expect.stringMatching(/^pi_fake_/) });
    expect(creates().map((r) => r.idempotencyKey)).toEqual([providerIdempotencyKey(pending.id), providerIdempotencyKey(pending.id)]);
    expect(await fundingRows()).toHaveLength(1);
    expect(await db.$count(transactionEvents)).toBe(1);
  });

  it("checks auth before anything else: a refused request is never validated or stored", async () => {
    cookie = undefined;
    const response = await post("{not json", null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue" } });
    expect(await fundingRows()).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("validates the Idempotency-Key and body with useful messages", async () => {
    const cases: Array<[unknown, string | null, string, string]> = [
      [{ amountCents: 50000 }, null, "invalid_idempotency_key", "Idempotency-Key header is required (1-255 characters)"],
      [{ amountCents: 50000 }, "  ", "invalid_idempotency_key", "Idempotency-Key header is required (1-255 characters)"],
      ["{not json", "k", "invalid_json", "Request body must be JSON"],
      [[1], "k", "invalid_request", 'Body must be an object like { "amountCents": 50000 }'],
      [{}, "k", "invalid_request", "amountCents must be a number of cents"],
      [{ amountCents: "500" }, "k", "invalid_request", "amountCents must be a number of cents"],
      [{ amountCents: 0 }, "k", "invalid_request", "amountCents must be positive"],
      [{ amountCents: -100 }, "k", "invalid_request", "amountCents must be positive"],
      [{ amountCents: 10.5 }, "k", "invalid_request", "amountCents must be whole cents"],
      [{ amountCents: 100_000_001 }, "k", "invalid_request", "amountCents must be at most 100000000 ($1,000,000)"],
    ];
    for (const [body, key, code, message] of cases) {
      const response = await post(body, key);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: { code, message } });
    }
    expect(await fundingRows()).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });
});
