import { asc, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/client";
import { accounts, holds, ledgerEntries, payments, transactionEvents, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { createFakeIncrease, type FakeIncrease } from "../integrations/increase/fake-increase";
import type { Logger } from "../lib/logger";
import { accountAvailableCents, lockAccount } from "../services/accounts";
import { postLedgerEntry } from "../services/ledger";
import { createPayment, outboxBacklog, paymentIdempotencyKey } from "../services/payments";
import { claimNextPayment, MAX_SUBMIT_ATTEMPTS, submitPayment, type SubmitOutcome } from "./payment-submitter";

const { pool, db } = createTestDb(20);
const PROVIDER_ACCOUNT_ID = "account_in71c4amph0vgo2qllky";
const ACCOUNT_NUMBER = "987654321";
let fake: FakeIncrease;
let lines: string[];
let logger: Logger;

async function fund(amountCents: number) {
  const transactionId = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents, provider: "stripe" });
  await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId, entryType: "FUNDING_CREDIT", amountCents }));
}

async function pay(idempotencyKey = "key-1", amountCents = 10000) {
  const input = { accountId: SEED.accountId, recipientName: "Globex Supplies", accountNumber: ACCOUNT_NUMBER, routingNumber: "101050001", amountCents, description: null, idempotencyKey };
  return (await createPayment(db, { name: "increase" }, input, logger)).payment;
}

/** One submitter pass: claim the next due payment and submit it. */
async function submitOnce(leaseSeconds = 60): Promise<SubmitOutcome | null> {
  const claim = await claimNextPayment(db, { leaseSeconds });
  return claim ? submitPayment(db, claim, fake.adapter, logger) : null;
}

/** Makes every waiting payment due now, as if its backoff had elapsed. */
const makeDue = () => db.update(payments).set({ nextSubmitAt: sql`now()` });

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
const creates = () => fake.requests.filter((r) => r.path === "/ach_transfers");

beforeEach(async () => {
  await resetDb(db);
  await db.update(accounts).set({ providerId: PROVIDER_ACCOUNT_ID }).where(eq(accounts.id, SEED.accountId));
  fake = createFakeIncrease({ timeoutMs: 50 });
  lines = [];
  logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) }) as unknown as Logger;
  await fund(50000);
});
afterAll(() => pool.end());

describe("payment submitter (outbox)", () => {
  it("submits a PENDING payment once with key payment-<id>: SUBMITTED, transfer id stored, balances unchanged", async () => {
    const payment = await pay();
    expect(await submitOnce()).toBe("submitted");
    expect(await submitOnce()).toBeNull();

    expect(creates()).toEqual([
      {
        method: "POST",
        path: "/ach_transfers",
        idempotencyKey: paymentIdempotencyKey(payment.id),
        body: { account_id: PROVIDER_ACCOUNT_ID, amount: 10000, account_number: ACCOUNT_NUMBER, routing_number: "101050001", individual_name: "Globex Supplies", statement_descriptor: "Payment" },
      },
    ]);
    const [transferId] = fake.achTransfers.keys();
    expect(await current(payment.id)).toMatchObject({ status: "SUBMITTED", provider: "increase", providerObjectId: transferId, submitAttempts: 1, lastSubmitError: null, submittedAt: expect.any(Date) });
    expect(await transactionOf(payment.transactionId)).toMatchObject({ status: "SUBMITTED", providerObjectId: transferId });
    expect((await trace(payment.transactionId)).map((t) => [t.kind, t.fromStatus, t.toStatus, t.providerRef, t.ledgerBalanceAfterCents, t.availableAfterCents])).toEqual([
      ["HOLD_CREATED", null, "ACTIVE", null, 50000, 40000],
      ["STATUS_CHANGED", null, "PENDING", null, 50000, 40000],
      ["STATUS_CHANGED", "PENDING", "SUBMITTED", transferId, 50000, 40000],
    ]);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
    for (const line of lines) expect(line).not.toContain(ACCOUNT_NUMBER);
  });

  it("the same Idempotency-Key raced at the API and then submitted gives one payment and one Increase transfer", async () => {
    await Promise.all(Array.from({ length: 5 }, () => pay("same-key")));
    await pay("same-key");
    while (await submitOnce()) await makeDue();
    expect(await db.$count(payments)).toBe(1);
    expect(creates()).toHaveLength(1);
    expect(fake.achTransfers.size).toBe(1);
  });

  it("a timeout then success: retried with backoff and the same key, one transfer", async () => {
    const payment = await pay();
    fake.next = "hang";
    expect(await submitOnce()).toBe("retry");
    const waiting = await current(payment.id);
    expect(waiting).toMatchObject({ status: "PENDING", submitAttempts: 1, lastSubmitError: expect.stringContaining("PaymentProviderError") });
    expect(waiting.nextSubmitAt.getTime()).toBeGreaterThan(Date.now());
    expect(await submitOnce()).toBeNull();

    await makeDue();
    expect(await submitOnce()).toBe("submitted");
    expect(creates().map((r) => r.idempotencyKey)).toEqual([paymentIdempotencyKey(payment.id), paymentIdempotencyKey(payment.id)]);
    expect(fake.achTransfers.size).toBe(1);
    expect(await current(payment.id)).toMatchObject({ status: "SUBMITTED", submitAttempts: 2, lastSubmitError: null });
  });

  it("a 5xx is retried like a timeout", async () => {
    const payment = await pay();
    fake.next = "error";
    expect(await submitOnce()).toBe("retry");
    expect((await current(payment.id)).lastSubmitError).toBe("PaymentProviderError: Increase create ACH transfer failed: internal_server_error");
  });

  it("Increase created the transfer but the answer was lost: the retry reuses the key and links the same transfer", async () => {
    const payment = await pay();
    fake.next = "succeed_then_hang";
    expect(await submitOnce()).toBe("retry");
    const [created] = fake.achTransfers.keys();
    expect((await current(payment.id)).providerObjectId).toBeNull();

    await makeDue();
    expect(await submitOnce()).toBe("submitted");
    expect(fake.achTransfers.size).toBe(1);
    expect((await current(payment.id)).providerObjectId).toBe(created);
  });

  it("a worker that died after the Increase create: the next claim (lease expired) links the same transfer", async () => {
    const payment = await pay();
    const crashed = await claimNextPayment(db, { leaseSeconds: 0 });
    expect(crashed).toMatchObject({ id: payment.id, attempts: 1, claimToken: 1 });
    // What the crashed worker had sent before dying.
    const sent = await fake.adapter.createTransfer({
      sourceAccountId: PROVIDER_ACCOUNT_ID,
      amountCents: 10000,
      accountNumber: ACCOUNT_NUMBER,
      routingNumber: "101050001",
      recipientName: "Globex Supplies",
      statementDescriptor: "Payment",
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });

    expect(await submitOnce()).toBe("submitted");
    expect(fake.achTransfers.size).toBe(1);
    expect(await current(payment.id)).toMatchObject({ status: "SUBMITTED", providerObjectId: sent.id, submitAttempts: 2, submitClaimToken: 2 });
    // The stale claim can no longer write anything.
    expect(await submitPayment(db, crashed!, fake.adapter, logger)).toBe("lease_lost");
    expect((await trace(payment.transactionId)).filter((t) => t.toStatus === "SUBMITTED")).toHaveLength(1);
  });

  it("Increase refusing the first attempt (4xx) → FAILED, hold released, trace row, no ledger entry", async () => {
    const payment = await pay();
    fake.next = "invalid";
    expect(await submitOnce()).toBe("rejected");
    expect(await current(payment.id)).toMatchObject({ status: "FAILED", lastSubmitError: "ProviderRejectedError: Increase create ACH transfer failed: invalid_parameters_error" });
    expect((await transactionOf(payment.transactionId)).status).toBe("FAILED");
    expect((await holdOf(payment.transactionId)).status).toBe("RELEASED");
    expect((await trace(payment.transactionId)).slice(2).map((t) => [t.kind, t.fromStatus, t.toStatus, t.availableAfterCents])).toEqual([
      ["HOLD_RELEASED", "ACTIVE", "RELEASED", 50000],
      ["STATUS_CHANGED", "PENDING", "FAILED", 50000],
    ]);
    expect(await db.$count(ledgerEntries, eq(ledgerEntries.transactionId, payment.transactionId))).toBe(0);
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 50000 });
    expect(await submitOnce()).toBeNull();
  });

  /** The payment has been given up on: still PENDING with its hold, out of the claim, with a trace row saying so. */
  async function expectGivenUp(payment: { id: string; transactionId: string }, error: string) {
    expect(await current(payment.id)).toMatchObject({ status: "PENDING", submitGaveUpAt: expect.any(Date), lastSubmitError: expect.stringContaining(error) });
    expect((await transactionOf(payment.transactionId)).status).toBe("PENDING");
    expect((await holdOf(payment.transactionId)).status).toBe("ACTIVE");
    expect((await trace(payment.transactionId)).at(-1)).toMatchObject({ kind: "STATUS_CHANGED", fromStatus: "PENDING", toStatus: "PENDING", availableAfterCents: 40000 });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 40000 });
    await makeDue();
    expect(await submitOnce()).toBeNull();
    expect(await outboxBacklog(db)).toMatchObject({ pending: 0, givenUp: 1 });
  }

  it(`after ${MAX_SUBMIT_ATTEMPTS} failed attempts it gives up: PENDING with the hold kept, never resubmitted`, async () => {
    const payment = await pay();
    await db.update(payments).set({ submitAttempts: MAX_SUBMIT_ATTEMPTS - 1 }).where(eq(payments.id, payment.id));
    fake.next = "hang";
    expect(await submitOnce()).toBe("gave_up");
    expect((await current(payment.id)).submitAttempts).toBe(MAX_SUBMIT_ATTEMPTS);
    await expectGivenUp(payment, "PaymentProviderError");
    expect(lines.map((line) => JSON.parse(line)).find((line) => line.outcome === "gave_up")).toMatchObject({ payment_id: payment.id });
  });

  it("a timeout and then a 4xx is unknown, not a refusal: the hold stays and the payment isn't FAILED", async () => {
    const payment = await pay();
    fake.next = "hang";
    expect(await submitOnce()).toBe("retry");
    await makeDue();
    fake.next = "invalid";
    expect(await submitOnce()).toBe("gave_up");
    await expectGivenUp(payment, "invalid_parameters_error");
  });

  it("401/403/409 are unknown even on the first attempt", async () => {
    const payment = await pay();
    fake.next = "reject";
    expect(await submitOnce()).toBe("gave_up");
    await expectGivenUp(payment, "invalid_operation_error");
  });

  it("a key already used for a different transfer gives up with the hold kept, never released", async () => {
    const payment = await pay();
    await fake.adapter.createTransfer({
      sourceAccountId: PROVIDER_ACCOUNT_ID,
      amountCents: 99,
      accountNumber: ACCOUNT_NUMBER,
      routingNumber: "101050001",
      recipientName: "Someone else",
      statementDescriptor: "Payment",
      idempotencyKey: paymentIdempotencyKey(payment.id),
    });
    expect(await submitOnce()).toBe("gave_up");
    await expectGivenUp(payment, "idempotency_key_already_used_error");
  });

  it("two submitter workers racing on the same payment submit it once", async () => {
    const payment = await pay();
    // Worker A's lease expires at once, so worker B claims the same payment while A is still working.
    const a = await claimNextPayment(db, { leaseSeconds: 0 });
    const b = await claimNextPayment(db, { leaseSeconds: 60 });
    expect([a?.id, b?.id]).toEqual([payment.id, payment.id]);
    const outcomes = await Promise.all([submitPayment(db, a!, fake.adapter, logger), submitPayment(db, b!, fake.adapter, logger)]);
    expect(outcomes.sort()).toEqual(["lease_lost", "submitted"]);
    expect(fake.achTransfers.size).toBe(1);
    expect((await trace(payment.transactionId)).filter((t) => t.toStatus === "SUBMITTED")).toHaveLength(1);

    // Fully concurrent: A works on its claim while B re-claims the payment once A's lease lapses.
    const raced = await pay("key-3");
    const first = await claimNextPayment(db, { leaseSeconds: 0 });
    const racing = await Promise.all([
      submitPayment(db, first!, fake.adapter, logger),
      claimNextPayment(db, { leaseSeconds: 60 }).then((claim) => (claim ? submitPayment(db, claim, fake.adapter, logger) : null)),
    ]);
    expect(racing).toContain("submitted");
    expect((await current(raced.id)).status).toBe("SUBMITTED");
    expect(fake.achTransfers.size).toBe(2);
    expect((await trace(raced.transactionId)).filter((t) => t.toStatus === "SUBMITTED")).toHaveLength(1);

    // Two workers claiming concurrently never get the same live claim.
    await pay("key-2");
    const claims = await Promise.all([claimNextPayment(db, { leaseSeconds: 60 }), claimNextPayment(db, { leaseSeconds: 60 })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("reports the backlog: how many are unsubmitted, the age of the oldest, and how many were given up", async () => {
    expect(await outboxBacklog(db)).toEqual({ pending: 0, oldestAgeSeconds: null, givenUp: 0 });
    const payment = await pay();
    await db.update(payments).set({ createdAt: sql`now() - interval '90 seconds'` }).where(eq(payments.id, payment.id));
    await pay("key-2");
    expect(await outboxBacklog(db)).toEqual({ pending: 2, oldestAgeSeconds: 90, givenUp: 0 });
    await db.update(payments).set({ submitGaveUpAt: sql`now()` }).where(eq(payments.id, payment.id));
    expect(await outboxBacklog(db)).toEqual({ pending: 1, oldestAgeSeconds: 0, givenUp: 1 });
  });
});
