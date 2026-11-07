import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../db/client";
import { accounts, auditEvents, holds, payments, transactionEvents } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../../../db/test-helpers";
import { createFakeIncrease, type FakeIncrease } from "../../../integrations/increase/fake-increase";
import { sessionConfig } from "../../../lib/config";
import { newId } from "../../../lib/ids";
import { logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { accountAvailableCents, lockAccount } from "../../../services/accounts";
import { postLedgerEntry } from "../../../services/ledger";
import { flushCounters, readCounters } from "../../../services/metrics";
import { CONFIRM_NOT_SENT_MIN_AGE_SECONDS, listGivenUpPayments } from "../../../services/ops-payments";
import { createPayment, type Payment } from "../../../services/payments";
import { claimNextPayment, MAX_SUBMIT_ATTEMPTS, submitPayment } from "../../../worker/payment-submitter";
import { handleConfirmPaymentNotSent, handleRequeuePayment } from "./payments/handle-ops-payments";

const { pool, db } = createTestDb(20);
let fake: FakeIncrease;

let cookie: string | undefined;
function signIn(role: "OWNER" | "OPS") {
  const userId = role === "OPS" ? SEED.opsUserId : SEED.ownerUserId;
  const accountId = role === "OWNER" ? SEED.accountId : null;
  const token = signSession({ userId, role, accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET);
  cookie = `${SESSION_COOKIE}=${token}`;
}
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) } });

async function json(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, body: await r.json() };
}

const requeue = (id: string, headers?: Record<string, string>) => json(handleRequeuePayment({ db, logger }, post(`/api/ops/payments/${id}/requeue`, headers), { id }));
const confirmNotSent = (id: string, headers?: Record<string, string>) =>
  json(handleConfirmPaymentNotSent({ db, provider: fake.adapter, logger }, post(`/api/ops/payments/${id}/confirm-not-sent`, headers), { id }));

async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

/**
 * A $100 payment the submitter gave up on: its last attempt failed the way `mode` makes the fake
 * fail. "error" sends nothing; "succeed_then_hang" creates the transfer at Increase and loses the
 * answer. Unless `fresh`, the give-up is backdated past the confirm-not-sent minimum age.
 */
async function givenUp(mode: "error" | "succeed_then_hang" = "error", { fresh = false } = {}): Promise<Payment> {
  const input = { accountId: SEED.accountId, recipientName: "Globex Supplies", accountNumber: "987654321", routingNumber: "101050001", amountCents: 10000, description: null, idempotencyKey: newId() };
  const { payment } = await createPayment(db, { name: "increase" }, input, logger);
  await db.update(payments).set({ submitAttempts: MAX_SUBMIT_ATTEMPTS - 1 }).where(eq(payments.id, payment.id));
  fake.next = mode;
  const claim = await claimNextPayment(db, { leaseSeconds: 60 });
  expect(await submitPayment(db, claim!, fake.adapter, logger)).toBe("gave_up");
  if (!fresh) {
    const age = CONFIRM_NOT_SENT_MIN_AGE_SECONDS + 1;
    await db.update(payments).set({ submitGaveUpAt: sql`now() - make_interval(secs => ${age})` }).where(eq(payments.id, payment.id));
  }
  return current(payment.id);
}

async function account() {
  const { cachedCents, ledgerSumCents, replayMatches } = await balances(db);
  expect(cachedCents).toBe(ledgerSumCents);
  expect(replayMatches).toBe(true);
  const availableCents = await withTransaction(db, async (tx) => accountAvailableCents(tx, SEED.accountId, (await lockAccount(tx, SEED.accountId)).ledgerBalanceCents));
  return { ledgerCents: cachedCents, availableCents };
}

const current = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const holdOf = async (transactionId: string) => (await db.select().from(holds).where(eq(holds.transactionId, transactionId)))[0];
const trace = async (transactionId: string) =>
  (await db.select().from(transactionEvents).where(eq(transactionEvents.transactionId, transactionId)).orderBy(asc(transactionEvents.seq))).map((t) => [
    t.kind,
    t.fromStatus,
    t.toStatus,
    t.availableAfterCents,
  ]);
const audit = () => db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt));
async function actionCounters() {
  await flushCounters(db, logger);
  return (await readCounters(db)).filter((c) => c.name === "ops_payment_actions_total").map((c) => [c.labels.action, c.labels.outcome, c.value]);
}

/** A given-up payment that an Ops action refused: still PENDING, given up, hold ACTIVE, nothing audited. */
async function expectUnchanged(payment: Payment) {
  expect(await current(payment.id)).toMatchObject({ status: "PENDING", submitGaveUpAt: payment.submitGaveUpAt, submitAttempts: payment.submitAttempts });
  expect((await holdOf(payment.transactionId)).status).toBe("ACTIVE");
  expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
  expect(await audit()).toEqual([]);
}

beforeEach(async () => {
  await flushCounters(db, logger); // drop what earlier tests buffered
  await resetDb(db);
  await db.update(accounts).set({ providerId: "account_in71c4amph0vgo2qllky" }).where(eq(accounts.id, SEED.accountId));
  fake = createFakeIncrease({ timeoutMs: 50 });
  await fund(50000);
  signIn("OPS");
});
afterAll(() => pool.end());

describe("Ops payment actions: access", () => {
  it("signed out → 401, owner → 403, cross-origin → 403; nothing changes and Increase isn't asked", async () => {
    const payment = await givenUp();
    const requests = fake.requests.length;
    for (const [role, status, code] of [
      [undefined, 401, "unauthenticated"],
      ["OWNER", 403, "forbidden"],
    ] as const) {
      cookie = undefined;
      if (role) signIn(role);
      for (const call of [requeue, confirmNotSent]) {
        const { status: got, body } = await call(payment.id);
        expect([got, body.error.code]).toEqual([status, code]);
      }
    }
    signIn("OPS");
    for (const call of [requeue, confirmNotSent]) {
      expect(await call(payment.id, { origin: "https://evil.example" })).toEqual({
        status: 403,
        body: { error: { code: "cross_origin", message: "This request must come from the Trace app" } },
      });
    }
    expect(fake.requests).toHaveLength(requests);
    await expectUnchanged(payment);
  });

  it("400 for a malformed id, 404 for an unknown payment", async () => {
    expect((await requeue("nope")).status).toBe(400);
    expect((await confirmNotSent("nope")).body.error.code).toBe("invalid_request");
    expect((await requeue(newId())).body.error.code).toBe("payment_not_found");
    expect((await confirmNotSent(newId())).body.error.code).toBe("payment_not_found");
  });
});

describe("POST /api/ops/payments/:id/requeue", () => {
  it("hands a given-up payment back to the submitter, which submits it with the same key; audited and counted", async () => {
    const payment = await givenUp();
    const { status, body } = await requeue(payment.id);
    expect(status).toBe(200);
    expect(body.payment).toEqual({ id: payment.id, status: "PENDING", submitAttempts: 0, nextSubmitAt: expect.any(String) });
    expect(await current(payment.id)).toMatchObject({ status: "PENDING", submitGaveUpAt: null, submitAttempts: 0 });
    expect(await audit()).toEqual([
      expect.objectContaining({
        actorId: SEED.opsUserId,
        action: "payment.requeue",
        entityType: "payment",
        entityId: payment.id,
        previousState: { status: "PENDING", submitAttempts: MAX_SUBMIT_ATTEMPTS, givenUp: true },
        newState: { status: "PENDING", submitAttempts: 0, givenUp: false },
        correlationId: expect.any(String),
      }),
    ]);

    const claim = await claimNextPayment(db, { leaseSeconds: 60 });
    expect(claim).toMatchObject({ id: payment.id, attempts: 1 });
    expect(await submitPayment(db, claim!, fake.adapter, logger)).toBe("submitted");
    expect(await current(payment.id)).toMatchObject({ status: "SUBMITTED", providerObjectId: expect.stringMatching(/^ach_transfer_fake_/) });
    expect(fake.achTransfers.size).toBe(1);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
    expect(await actionCounters()).toEqual([["requeue", "requeued", 1]]);
  });

  it("a requeue after Increase created the transfer links that transfer, never a second one", async () => {
    const payment = await givenUp("succeed_then_hang");
    const [created] = fake.achTransfers.keys();
    expect((await requeue(payment.id)).status).toBe(200);
    const claim = await claimNextPayment(db, { leaseSeconds: 60 });
    expect(await submitPayment(db, claim!, fake.adapter, logger)).toBe("submitted");
    expect(fake.achTransfers.size).toBe(1);
    expect((await current(payment.id)).providerObjectId).toBe(created);
  });

  it("a double click or two Ops users at once: one requeue, the other 409 with nothing changed", async () => {
    const payment = await givenUp();
    const results = await Promise.all([requeue(payment.id), requeue(payment.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toEqual({
      code: "payment_not_given_up",
      message: "Only payments the submitter gave up on can be resolved here; this one is PENDING and still being submitted",
    });
    expect(await audit()).toHaveLength(1);
    expect(await actionCounters()).toEqual([
      ["requeue", "not_given_up", 1],
      ["requeue", "requeued", 1],
    ]);
  });
});

describe("POST /api/ops/payments/:id/confirm-not-sent", () => {
  it("Increase has no transfer under our key: FAILED, hold released (effect row first), replay matches, audited", async () => {
    const payment = await givenUp();
    const { status, body } = await confirmNotSent(payment.id);
    expect({ status, body }).toEqual({ status: 200, body: { payment: { id: payment.id, status: "FAILED" } } });
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/ach_transfers" });

    expect(await current(payment.id)).toMatchObject({ status: "FAILED" });
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect((await trace(payment.transactionId)).slice(-2)).toEqual([
      ["HOLD_RELEASED", "ACTIVE", "RELEASED", 50000],
      ["STATUS_CHANGED", "PENDING", "FAILED", 50000],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
    expect(await audit()).toEqual([
      expect.objectContaining({
        actorId: SEED.opsUserId,
        action: "payment.confirm_not_sent",
        entityId: payment.id,
        previousState: { status: "PENDING", holdStatus: "ACTIVE", givenUp: true },
        newState: { status: "FAILED", holdStatus: "RELEASED" },
      }),
    ]);
    expect(await actionCounters()).toEqual([["confirm_not_sent", "failed", 1]]);
  });

  it("Increase has a transfer under our key: 409 naming it, nothing changed", async () => {
    const payment = await givenUp("succeed_then_hang");
    const [created] = fake.achTransfers.keys();
    expect(await confirmNotSent(payment.id)).toEqual({
      status: 409,
      body: { error: { code: "transfer_exists", message: `Increase has transfer ${created} for this payment, so it may have been sent; nothing changed` } },
    });
    await expectUnchanged(payment);
    expect(await actionCounters()).toEqual([["confirm_not_sent", "transfer_exists", 1]]);
  });

  it(`within ${CONFIRM_NOT_SENT_MIN_AGE_SECONDS / 60} minutes of the give-up: 409 too_soon, Increase not asked, nothing changed`, async () => {
    const payment = await givenUp("error", { fresh: true });
    const requests = fake.requests.length;
    expect(await confirmNotSent(payment.id)).toEqual({
      status: 409,
      body: { error: { code: "too_soon", message: "Wait until 5 minutes after the submitter gave up, so Increase has caught up; nothing changed" } },
    });
    expect(fake.requests).toHaveLength(requests);
    expect((await listGivenUpPayments(db)).map((p) => p.confirmable)).toEqual([false]);
    await expectUnchanged(payment);
    expect(await actionCounters()).toEqual([["confirm_not_sent", "too_soon", 1]]);

    const age = CONFIRM_NOT_SENT_MIN_AGE_SECONDS + 1;
    await db.update(payments).set({ submitGaveUpAt: sql`now() - make_interval(secs => ${age})` }).where(eq(payments.id, payment.id));
    expect((await listGivenUpPayments(db)).map((p) => p.confirmable)).toEqual([true]);
    expect((await confirmNotSent(payment.id)).status).toBe(200);
  });

  it("Increase can't be asked (5xx or timeout): 502, nothing changed", async () => {
    const payment = await givenUp();
    for (const mode of ["error", "hang"] as const) {
      fake.next = mode;
      expect(await confirmNotSent(payment.id)).toEqual({
        status: 502,
        body: { error: { code: "provider_unavailable", message: "Couldn't check with Increase whether the payment was sent; nothing changed, try again" } },
      });
    }
    await expectUnchanged(payment);
    expect(await actionCounters()).toEqual([["confirm_not_sent", "provider_error", 2]]);
  });

  it("a double click or two at once: one fails the payment, the other 409; the hold is released once", async () => {
    const payment = await givenUp();
    const results = await Promise.all([confirmNotSent(payment.id), confirmNotSent(payment.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(["payment_changed", "payment_not_given_up"]).toContain(results.find((r) => r.status === 409)!.body.error.code);
    expect((await confirmNotSent(payment.id)).body.error).toEqual({
      code: "payment_not_given_up",
      message: "Only payments the submitter gave up on can be resolved here; this one is FAILED",
    });
    expect((await trace(payment.transactionId)).filter(([kind]) => kind === "HOLD_RELEASED")).toHaveLength(1);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
    expect(await audit()).toHaveLength(1);
  });

  it("a payment requeued and claimed after Increase was asked isn't failed on that stale answer", async () => {
    const payment = await givenUp();
    // Between the Increase check and the transaction: Ops requeues it and the submitter claims it, then gives up again.
    const original = fake.adapter.findTransferByIdempotencyKey.bind(fake.adapter);
    fake.adapter.findTransferByIdempotencyKey = async (key) => {
      const answer = await original(key);
      await requeue(payment.id);
      await db.update(payments).set({ submitAttempts: MAX_SUBMIT_ATTEMPTS - 1 }).where(eq(payments.id, payment.id));
      fake.next = "error";
      const claim = await claimNextPayment(db, { leaseSeconds: 60 });
      expect(await submitPayment(db, claim!, fake.adapter, logger)).toBe("gave_up");
      return answer;
    };
    const { status, body } = await confirmNotSent(payment.id);
    expect([status, body.error.code]).toEqual([409, "payment_changed"]);
    expect(await current(payment.id)).toMatchObject({ status: "PENDING", submitGaveUpAt: expect.any(Date) });
    expect((await holdOf(payment.transactionId)).status).toBe("ACTIVE");
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
  });

  it("only a given-up payment qualifies: one still being submitted is 409 and Increase isn't asked", async () => {
    const input = { accountId: SEED.accountId, recipientName: "Globex", accountNumber: "987654321", routingNumber: "101050001", amountCents: 100, description: null, idempotencyKey: newId() };
    const { payment } = await createPayment(db, { name: "increase" }, input, logger);
    expect((await confirmNotSent(payment.id)).body.error.code).toBe("payment_not_given_up");
    expect((await requeue(payment.id)).body.error.code).toBe("payment_not_given_up");
    expect(fake.requests).toEqual([]);
    expect(await db.$count(payments, sql`${payments.submitGaveUpAt} IS NOT NULL`)).toBe(0);
  });
});
