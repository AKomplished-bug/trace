import { asc, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../db/client";
import { accounts, businesses, holds, payments, transactionEvents, transactions } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../../../db/test-helpers";
import { sessionConfig } from "../../../lib/config";
import type { Logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { accountAvailableCents, lockAccount } from "../../../services/accounts";
import { postLedgerEntry } from "../../../services/ledger";
import { handleCreatePayment, handleGetPayment, handleListPayments } from "./handle-payments";

const { pool, db } = createTestDb(20);
const PROVIDER_ACCOUNT_ID = "account_in71c4amph0vgo2qllky";
const ACCOUNT_NUMBER = "987654321";
const body = { recipientName: "Globex Supplies", accountNumber: ACCOUNT_NUMBER, routingNumber: "101050001", amountCents: 10000, description: "Invoice 2468" };

// Every log line the handlers write, to check nothing sensitive is logged.
let lines: string[];
let logger: Logger;
let cookie: string | undefined;
const ownerCookie = () =>
  `${SESSION_COOKIE}=${signSession(
    { userId: SEED.ownerUserId, role: "OWNER", accountId: SEED.accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 },
    sessionConfig().SESSION_SECRET,
  )}`;

function post(payload: unknown, idempotencyKey: string | null = "key-1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  const request = new Request("http://localhost/api/payments", { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  return handleCreatePayment({ db, provider: { name: "increase" }, logger }, request);
}

const get = (path: string) => new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

/** Funds the account through the ledger service, as a settled Stripe funding would. */
async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

async function account() {
  const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  expect(replayMatches).toBe(true);
  const availableCents = await withTransaction(db, async (tx) => accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents));
  return { ledgerCents: cachedCents, availableCents };
}

const paymentTransactions = () => db.select().from(transactions).where(eq(transactions.type, "OUTBOUND_PAYMENT"));

beforeEach(async () => {
  await resetDb(db);
  await db.update(accounts).set({ providerId: PROVIDER_ACCOUNT_ID }).where(eq(accounts.id, SEED.accountId));
  lines = [];
  logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) }) as unknown as Logger;
  cookie = ownerCookie();
});
afterAll(() => pool.end());

describe("POST /api/payments", () => {
  it("$500 funded → $100 payment: 201 PENDING, hold reserves it (ledger 500 / available 400), no provider call", async () => {
    await fund(50000);
    const response = await post(body);
    expect(response.status).toBe(201);
    const { payment } = await response.json();
    expect(payment).toMatchObject({
      status: "PENDING",
      amountCents: 10000,
      currency: "USD",
      recipientName: "Globex Supplies",
      accountNumberLast4: "4321",
      routingNumber: "101050001",
      description: "Invoice 2468",
      provider: "increase",
      providerObjectId: null,
      holdCents: 10000,
      holdStatus: "ACTIVE",
      postedCents: null,
    });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });

    const [transaction] = await paymentTransactions();
    expect(transaction).toMatchObject({ id: payment.transactionId, status: "PENDING", amountCents: 10000, provider: "increase", idempotencyKey: "key-1" });
    const [stored] = await db.select().from(payments);
    expect(stored).toMatchObject({ accountNumber: ACCOUNT_NUMBER, status: "PENDING", submitAttempts: 0 });
    expect(await db.select().from(holds).where(eq(holds.transactionId, transaction.id))).toMatchObject([{ kind: "PENDING_PAYMENT", status: "ACTIVE", amountCents: 10000 }]);
    const trace = await db.select().from(transactionEvents).where(eq(transactionEvents.transactionId, transaction.id)).orderBy(asc(transactionEvents.seq));
    expect(trace.map((t) => [t.kind, t.toStatus, t.ledgerBalanceAfterCents, t.availableAfterCents])).toEqual([
      ["HOLD_CREATED", "ACTIVE", 50000, 40000],
      ["STATUS_CHANGED", "PENDING", 50000, 40000],
    ]);
  });

  it("never returns or logs the full account number or the routing number", async () => {
    await fund(50000);
    const created = await (await post(body)).text();
    const { payment } = JSON.parse(created);
    const listed = await (await handleListPayments({ db, logger }, get("/api/payments"))).text();
    const fetched = await (await handleGetPayment({ db, logger }, get(`/api/payments/${payment.id}`), { id: payment.id })).text();
    for (const text of [created, listed, fetched]) expect(text).not.toContain(ACCOUNT_NUMBER);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(ACCOUNT_NUMBER);
      expect(line).not.toContain(body.routingNumber);
    }
  });

  it("the same key and body returns the same payment, sequentially and concurrently", async () => {
    await fund(50000);
    const first = await (await post(body)).json();
    const replay = await post(body);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(first);

    const racing = await Promise.all(Array.from({ length: 5 }, () => post(body, "key-2")));
    expect(racing.map((r) => r.status)).toEqual(Array(5).fill(201));
    const ids = new Set(await Promise.all(racing.map(async (r) => (await r.json()).payment.id)));
    expect(ids.size).toBe(1);
    expect(await db.$count(payments)).toBe(2);
    expect(await db.$count(holds)).toBe(2);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 30000 });
  });

  it("the same key with a different body is 409 and changes nothing", async () => {
    await fund(50000);
    await post(body);
    const response = await post({ ...body, amountCents: 20000 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "idempotency_conflict", message: "This Idempotency-Key was already used with a different request body" } });
    expect(await db.$count(payments)).toBe(1);
  });

  it("insufficient available balance is 422 with nothing created", async () => {
    await fund(5000);
    const before = { trace: await db.$count(transactionEvents), transactions: await db.$count(transactions) };
    const response = await post(body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "insufficient_funds", message: "Available balance is $50.00; this payment needs $100.00. Nothing was sent." },
    });
    expect(await db.$count(payments)).toBe(0);
    expect(await db.$count(holds)).toBe(0);
    expect({ trace: await db.$count(transactionEvents), transactions: await db.$count(transactions) }).toEqual(before);
    // Nothing was stored under the key, so a retry once funds arrive goes through.
    await fund(5000);
    expect((await post(body)).status).toBe(201);
  });

  it("concurrent payments that together exceed available: only those that fit succeed", async () => {
    await fund(50000);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => post({ ...body, amountCents: 15000 }, `race-${i}`)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 422, 422, 422, 422, 422]);
    expect(await db.$count(payments)).toBe(3);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 5000 });
  });

  it("an account not linked to Increase is refused with 409 and nothing created", async () => {
    await fund(50000);
    await db.update(accounts).set({ providerId: null }).where(eq(accounts.id, SEED.accountId));
    const response = await post(body);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("account_not_linked");
    expect(await paymentTransactions()).toHaveLength(0);
  });

  it("checks auth before anything else", async () => {
    cookie = undefined;
    const response = await post("{not json", null);
    expect(response.status).toBe(401);
    expect(await paymentTransactions()).toHaveLength(0);
  });

  it("validates the key and body with useful messages", async () => {
    const cases: Array<[unknown, string | null, string, string]> = [
      [body, null, "invalid_idempotency_key", "Idempotency-Key header is required (1-255 characters)"],
      ["{not json", "k", "invalid_json", "Request body must be JSON"],
      [{ ...body, routingNumber: "101050002" }, "k", "invalid_request", "routingNumber: is not a valid ABA routing number (check digit doesn't match)"],
      [{ ...body, routingNumber: "10105" }, "k", "invalid_request", "routingNumber: must be 9 digits; routingNumber: is not a valid ABA routing number (check digit doesn't match)"],
      [{ ...body, accountNumber: "12-34" }, "k", "invalid_request", "accountNumber: must be 4 to 17 digits"],
      [{ ...body, recipientName: "" }, "k", "invalid_request", "recipientName: must not be empty; recipientName: must use plain letters, digits and punctuation"],
      [{ ...body, recipientName: "A very long recipient name" }, "k", "invalid_request", "recipientName: must be at most 22 characters"],
      [{ ...body, amountCents: 0 }, "k", "invalid_request", "amountCents: must be positive"],
      [{ ...body, amountCents: 10.5 }, "k", "invalid_request", "amountCents: must be whole cents"],
      [{ ...body, amountCents: 100_000_001 }, "k", "invalid_request", "amountCents: must be at most 100000000 ($1,000,000)"],
      [{ ...body, description: "Café" }, "k", "invalid_request", "description: must use plain letters, digits and punctuation"],
    ];
    for (const [payload, key, code, message] of cases) {
      const response = await post(payload, key);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(await response.json()).toEqual({ error: { code, message } });
    }
    expect(await paymentTransactions()).toHaveLength(0);
  });
});

describe("GET /api/payments and /api/payments/:id", () => {
  it("lists newest first with a cursor and hides another business's payment", async () => {
    await fund(50000);
    for (const key of ["a", "b", "c"]) await post({ ...body, amountCents: 1000 }, key);
    const page = await (await handleListPayments({ db, logger }, get("/api/payments?limit=2"))).json();
    expect(page.items).toHaveLength(2);
    const rest = await (await handleListPayments({ db, logger }, get(`/api/payments?limit=2&cursor=${page.nextCursor}`))).json();
    expect(rest).toMatchObject({ items: [{ accountNumberLast4: "4321" }], nextCursor: null });
    expect(new Set([...page.items, ...rest.items].map((p: { id: string }) => p.id)).size).toBe(3);

    const [other] = await db.insert(businesses).values({ name: "Other Co" }).returning();
    const [otherAccount] = await db.insert(accounts).values({ businessId: other.id }).returning();
    const otherTransaction = await createTransaction(db, { accountId: otherAccount.id, type: "OUTBOUND_PAYMENT", amountCents: 100 });
    const [otherPayment] = await db
      .insert(payments)
      .values({ accountId: otherAccount.id, transactionId: otherTransaction, recipient: "X", accountNumber: "11112222", routingNumber: "101050001", amountCents: 100 })
      .returning();
    const response = await handleGetPayment({ db, logger }, get(`/api/payments/${otherPayment.id}`), { id: otherPayment.id });
    expect(response.status).toBe(404);
    expect((await handleGetPayment({ db, logger }, get("/api/payments/nope"), { id: "nope" })).status).toBe(400);
  });
});
