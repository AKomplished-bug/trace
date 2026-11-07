import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../app/api/webhooks/handle-webhook";
import { withTransaction } from "../db/client";
import { cards, eventDeliveries, externalEvents, providerCursors, transactions } from "../db/schema";
import { SEED } from "../db/seed";
import { balances, createTestDb, createTransaction, resetDb } from "../db/test-helpers";
import { INCREASE_IGNORED_EVENT_TYPES } from "../integrations/increase";
import { cardPaymentEvent, createFakeIncrease, signedIncreaseWebhook, type FakeIncrease } from "../integrations/increase/fake-increase";
import { logger } from "../lib/logger";
import { claimNextEvent, processEvent, type ProcessOutcome } from "../worker/events";
import { handlerKey, type EventRouting } from "../worker/handlers";
import { increaseHandlers, increaseTransferHandlers } from "../worker/increase";
import { accountAvailableCents, lockAccount } from "./accounts";
import { advanceCursor, claimCursor, POLL_COUNTER, POLL_OVERLAP_SECONDS, POLL_START_LOOKBACK_SECONDS, pollIncreaseEvents } from "./increase-events-poller";
import { postLedgerEntry } from "./ledger";
import { flushCounters, readCounters } from "./metrics";

const { pool, db } = createTestDb(20);
const PROVIDER_CARD_ID = "card_oubs0hwk5rn6knuecxg2";
let fake: FakeIncrease;

const poll = (options: { maxPages?: number } = {}) => pollIncreaseEvents(db, fake.adapter, logger, { leaseSeconds: 60, ...options });

function routing(): EventRouting {
  const handlers = Object.fromEntries(
    Object.entries({ ...increaseHandlers(() => fake.adapter), ...increaseTransferHandlers(() => fake.adapter) }).map(([type, handler]) => [handlerKey("increase", type), handler]),
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

// Ten minutes ago in whole seconds: inside the first pass's lookback, with room for later events.
let base: number;
const iso = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** An event in the fake's feed, created at `createdAt` (whole seconds, like Increase). */
function addEvent(id: string, createdAt: string, category = "card_payment.updated") {
  const event = { ...cardPaymentEvent("card_payment_fake_feed", category, id), created_at: createdAt };
  fake.events.push(event);
  return event;
}

const storedIds = async () => (await db.select({ id: externalEvents.externalEventId }).from(externalEvents).orderBy(asc(externalEvents.externalEventId))).map((e) => e.id);

async function deliveriesOf(externalEventId: string) {
  return db
    .select({ source: eventDeliveries.source, isDuplicate: eventDeliveries.isDuplicate })
    .from(eventDeliveries)
    .innerJoin(externalEvents, eq(externalEvents.id, eventDeliveries.externalEventId))
    .where(eq(externalEvents.externalEventId, externalEventId))
    .orderBy(asc(eventDeliveries.receivedAt));
}

async function polledCounters(): Promise<Record<string, number>> {
  await flushCounters(db, logger);
  const rows = (await readCounters(db)).filter((row) => row.name === POLL_COUNTER);
  return Object.fromEntries(rows.map((row) => [row.labels.outcome, row.value]));
}

async function cursor() {
  const [row] = await db.select().from(providerCursors).where(eq(providerCursors.provider, "increase"));
  return row;
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

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
  await db.update(cards).set({ providerId: PROVIDER_CARD_ID }).where(eq(cards.id, SEED.cardId));
  fake = createFakeIncrease();
  base = Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000;
});
afterAll(() => pool.end());

describe("Increase events poller", () => {
  it("ingests each new event once, and the worker applies it: $500, authorize $80 → 500/420, settle $65 → 435/435", async () => {
    const funding = await createTransaction(db, { type: "FUNDING", status: "SETTLED", amountCents: 50000, provider: "stripe" });
    await withTransaction(db, (tx) => postLedgerEntry(tx, { accountId: SEED.accountId, transactionId: funding, entryType: "FUNDING_CREDIT", amountCents: 50000 }));
    const { cardPaymentId } = await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents: 8000 });
    // A category without a handler isn't read at all.
    addEvent("event_fake_card_created", fake.events[0].created_at, "card.created");

    expect(await poll()).toEqual({ outcome: "polled", counts: { new: 1, duplicate: 0, already_polled: 0 }, more: false });
    expect(await poll()).toEqual({ outcome: "polled", counts: { new: 0, duplicate: 0, already_polled: 1 }, more: false });
    const [stored] = await db.select().from(externalEvents);
    // The stored payload is the Event object as listed, the same body a webhook delivers.
    expect(stored).toMatchObject({ provider: "increase", externalEventId: fake.events[0].id, eventType: "card_payment.created", payload: fake.events[0], status: "RECEIVED" });
    expect(await deliveriesOf(fake.events[0].id)).toEqual([{ source: "poll", isDuplicate: false }]);

    expect(await drain()).toEqual(["processed"]);
    const [purchase] = await db.select().from(transactions).where(eq(transactions.providerObjectId, cardPaymentId));
    expect(purchase).toMatchObject({ type: "CARD_PURCHASE", status: "AUTHORIZED", amountCents: 8000 });
    expect(await account()).toEqual({ ledgerCents: 50000, availableCents: 42000 });

    await fake.adapter.simulateSettlement({ cardPaymentId, amountCents: 6500 });
    expect((await poll()).counts).toEqual({ new: 1, duplicate: 0, already_polled: 1 });
    expect(await drain()).toEqual(["processed"]);
    expect(await account()).toEqual({ ledgerCents: 43500, availableCents: 43500 });
    expect(await polledCounters()).toEqual({ new: 2, already_polled: 2 });
  });

  it("reads ach_transfer events too", async () => {
    const transfer = await fake.adapter.createTransfer({
      sourceAccountId: "account_in71c4amph0vgo2qllky",
      amountCents: 10000,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Globex Supplies",
      statementDescriptor: "Invoice 2468",
      idempotencyKey: "payment-poll-test",
    });
    await fake.adapter.simulateTransferSubmission(transfer.id);
    expect((await poll()).counts.new).toBe(2);
    const rows = await db.select({ type: externalEvents.eventType, payload: externalEvents.payload }).from(externalEvents).orderBy(asc(externalEvents.receivedAt));
    expect(rows).toMatchObject([
      { type: "ach_transfer.created", payload: { associated_object_id: transfer.id } },
      { type: "ach_transfer.updated", payload: { associated_object_id: transfer.id } },
    ]);
  });

  it("collapses a webhook and a poll of the same event into one event with both deliveries", async () => {
    const event = addEvent("event_fake_both", iso(0));
    const { body, headers } = signedIncreaseWebhook(event);
    const request = new Request("http://localhost/api/webhooks/increase", { method: "POST", body, headers });
    expect((await handleWebhook({ db, webhookVerifiers: { increase: fake.adapter }, logger }, "increase", request)).status).toBe(200);

    expect((await poll()).counts).toEqual({ new: 0, duplicate: 1, already_polled: 0 });
    expect((await poll()).counts).toEqual({ new: 0, duplicate: 0, already_polled: 1 });
    expect(await storedIds()).toEqual(["event_fake_both"]);
    expect(await deliveriesOf("event_fake_both")).toEqual([
      { source: "webhook", isDuplicate: false },
      { source: "poll", isDuplicate: true },
    ]);
    const [stored] = await db.select({ payload: externalEvents.payload }).from(externalEvents);
    expect(stored.payload).toEqual(event);
    expect(await polledCounters()).toEqual({ duplicate: 1, already_polled: 1 });
  });

  it("starts an hour back when it has no cursor yet", async () => {
    addEvent("event_fake_history", iso(-POLL_START_LOOKBACK_SECONDS));
    addEvent("event_fake_recent", iso(0));
    expect((await poll()).counts.new).toBe(1);
    expect(await storedIds()).toEqual(["event_fake_recent"]);
  });

  it("ignores events about other cards and transfers in the group in one pass, and still applies ours", async () => {
    const foreignCard = await fake.adapter.simulateAuthorization({ cardId: "sandbox_card_probe", amountCents: 100 });
    const foreignTransfer = await fake.adapter.createTransfer({
      sourceAccountId: "sandbox_account_probe",
      amountCents: 100,
      accountNumber: "987654321",
      routingNumber: "101050001",
      recipientName: "Probe",
      statementDescriptor: "Probe",
      idempotencyKey: "probe-transfer",
    });
    const ours = await fake.adapter.simulateAuthorization({ cardId: PROVIDER_CARD_ID, amountCents: 8000 });
    expect((await poll()).counts.new).toBe(3);

    expect(await drain()).toEqual(["not_ours", "not_ours", "processed"]);
    const rows = await db
      .select({ type: externalEvents.eventType, status: externalEvents.status, attempts: externalEvents.attempts, lastError: externalEvents.lastError })
      .from(externalEvents)
      .orderBy(asc(externalEvents.receivedAt));
    expect(rows).toEqual([
      { type: "card_payment.created", status: "IGNORED", attempts: 1, lastError: expect.stringContaining(`not ours: CardNotOursError: No card with increase id sandbox_card_probe for card payment ${foreignCard.cardPaymentId}`) },
      { type: "ach_transfer.created", status: "IGNORED", attempts: 1, lastError: expect.stringContaining(`not ours: PaymentNotOursError: increase transfer ${foreignTransfer.id}`) },
      { type: "card_payment.created", status: "PROCESSED", attempts: 1, lastError: null },
    ]);
    const [purchase] = await db.select().from(transactions).where(eq(transactions.providerObjectId, ours.cardPaymentId));
    expect(purchase).toMatchObject({ status: "AUTHORIZED", amountCents: 8000 });
    await flushCounters(db, logger);
    const processed = (await readCounters(db)).filter((row) => row.name === "events_processed_total").map((row) => [row.labels.type, row.labels.outcome, row.value]);
    expect(processed).toEqual(
      expect.arrayContaining([
        ["ach_transfer.created", "not_ours", 1],
        ["card_payment.created", "not_ours", 1],
        ["card_payment.created", "processed", 1],
      ]),
    );
  });

  it("keeps its cursor between passes and re-reads an overlap window, catching late and same-second events", async () => {
    const t = base;
    addEvent("event_fake_1", iso(0));
    expect((await poll()).counts.new).toBe(1);
    expect(await cursor()).toMatchObject({ lastEventCreatedAt: new Date(t), lastExternalEventId: "event_fake_1", leaseUntil: null });

    // Visible only now: one created in the same second, one just inside the overlap, one outside it, one later.
    addEvent("event_fake_same_second", iso(0));
    addEvent("event_fake_late", iso(-(POLL_OVERLAP_SECONDS - 1)));
    addEvent("event_fake_too_old", iso(-(POLL_OVERLAP_SECONDS + 1)));
    addEvent("event_fake_2", iso(5));
    expect((await poll()).counts).toEqual({ new: 3, duplicate: 0, already_polled: 1 });
    expect(await storedIds()).toEqual(["event_fake_1", "event_fake_2", "event_fake_late", "event_fake_same_second"]);
    expect(await cursor()).toMatchObject({ lastEventCreatedAt: new Date(t + 5000), lastExternalEventId: "event_fake_2" });
  });

  it("stops at the page cap with the cursor saved and continues from it on the next pass", async () => {
    for (let i = 0; i < 150; i++) addEvent(`event_fake_${String(i).padStart(3, "0")}`, iso(i));
    expect(await poll({ maxPages: 1 })).toEqual({ outcome: "polled", counts: { new: 100, duplicate: 0, already_polled: 0 }, more: true });
    expect(await cursor()).toMatchObject({ lastExternalEventId: "event_fake_099" });
    // Each pass starts 60 s before the cursor: 039…138 (61 re-read, 39 new), then 078…149 (61 re-read, 11 new).
    expect(await poll({ maxPages: 1 })).toEqual({ outcome: "polled", counts: { new: 39, duplicate: 0, already_polled: 61 }, more: true });
    expect(await poll({ maxPages: 1 })).toEqual({ outcome: "polled", counts: { new: 11, duplicate: 0, already_polled: 61 }, more: false });
    expect((await storedIds()).length).toBe(150);
  });

  it("lets one of two racing pollers read at a time; each event is stored and polled once", async () => {
    for (let i = 0; i < 5; i++) addEvent(`event_fake_race_${i}`, iso(0));
    const results = await Promise.all([poll(), poll()]);
    expect(results.reduce((sum, r) => sum + r.counts.new, 0)).toBe(5);
    expect(results.map((r) => r.outcome).sort()).toEqual(expect.arrayContaining(["polled"]));
    const { rows } = await db.execute<{ polls: number }>(
      sql`SELECT count(*)::int AS polls FROM ${eventDeliveries} WHERE source = 'poll' GROUP BY external_event_id`,
    );
    expect(rows.map((r) => r.polls)).toEqual([1, 1, 1, 1, 1]);

    // While another worker holds the lease, a pass reads nothing.
    const held = await claimCursor(db, "increase", 60);
    const requests = fake.requests.length;
    expect((await poll()).outcome).toBe("busy");
    expect(fake.requests).toHaveLength(requests);

    // A claim whose lease expired and was taken over can't move the cursor.
    await db.update(providerCursors).set({ leaseUntil: sql`now() - interval '1 second'` });
    const taken = await claimCursor(db, "increase", 60);
    const to = { createdAt: new Date(), externalEventId: "event_fake_x" };
    expect(await advanceCursor(db, "increase", held!.claimToken, to)).toBe(false);
    expect(await advanceCursor(db, "increase", taken!.claimToken, to)).toBe(true);
  });

  it("counts a failed pass, releases the cursor and reads on the next pass", async () => {
    addEvent("event_fake_after_error", iso(0));
    fake.next = "error";
    expect(await poll()).toEqual({ outcome: "error", counts: { new: 0, duplicate: 0, already_polled: 0 }, more: false });
    expect((await cursor()).leaseUntil).toBeNull();
    expect((await poll()).counts.new).toBe(1);
    expect(await polledCounters()).toEqual({ error: 1, new: 1 });
  });
});
