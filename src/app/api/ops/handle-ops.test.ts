import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../../../db/client";
import { auditEvents, eventDeliveries, externalEvents, payments } from "../../../db/schema";
import { SEED } from "../../../db/seed";
import { createTestDb, createTransaction, resetDb } from "../../../db/test-helpers";
import { sessionConfig } from "../../../lib/config";
import { newId } from "../../../lib/ids";
import { logger } from "../../../lib/logger";
import { SESSION_COOKIE, signSession } from "../../../lib/session";
import { countOutcome, flushCounters } from "../../../services/metrics";
import { appendTraceEvent } from "../../../services/trace";
import { handleGetEvent, handleListEvents, handleRetryEvent } from "./events/handle-ops-events";
import { handleGetMetrics } from "./metrics/handle-metrics";

const { pool, db } = createTestDb();
const deps = { db, logger };
// Stands in for personal data in a provider payload.
const PII = "jane.doe@example.com";

let cookie: string | undefined;
function signIn(role: "OWNER" | "OPS") {
  const userId = role === "OPS" ? SEED.opsUserId : SEED.ownerUserId;
  const accountId = role === "OWNER" ? SEED.accountId : null;
  const token = signSession({ userId, role, accountId, expiresAt: Math.floor(Date.now() / 1000) + 600 }, sessionConfig().SESSION_SECRET);
  cookie = `${SESSION_COOKIE}=${token}`;
}
const request = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } });

async function json(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, body: await r.json() };
}

async function insertEvent(values: Partial<PgInsertValue<typeof externalEvents>> = {}) {
  const [{ id }] = await db
    .insert(externalEvents)
    .values({
      provider: "stripe",
      externalEventId: `evt_${newId()}`,
      eventType: "payment_intent.succeeded",
      payload: { customer: { email: PII } },
      correlationId: newId(),
      ...values,
    })
    .returning({ id: externalEvents.id });
  return id;
}

const list = (query = "") => json(handleListEvents(deps, request(`/api/ops/events${query}`)));
const detail = (id: string) => json(handleGetEvent(deps, request(`/api/ops/events/${id}`), { id }));
const retry = (id: string) => json(handleRetryEvent(deps, request(`/api/ops/events/${id}/retry`, "POST"), { id }));

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
  signIn("OPS");
});
afterAll(() => pool.end());

describe("Ops API access", () => {
  const routes = (id: string) => [
    () => handleListEvents(deps, request("/api/ops/events")),
    () => handleGetEvent(deps, request(`/api/ops/events/${id}`), { id }),
    () => handleRetryEvent(deps, request(`/api/ops/events/${id}/retry`, "POST"), { id }),
    () => handleGetMetrics(deps, request("/api/ops/metrics")),
  ];

  it("signed out → 401, owner → 403, on every route; an owner's retry changes nothing", async () => {
    const id = await insertEvent({ status: "FAILED" });
    for (const [role, status, code] of [
      [undefined, 401, "unauthenticated"],
      ["OWNER", 403, "forbidden"],
    ] as const) {
      cookie = undefined;
      if (role) signIn(role);
      for (const call of routes(id)) {
        const { status: got, body } = await json(call());
        expect([got, body.error.code]).toEqual([status, code]);
      }
    }
    const [row] = await db.select().from(externalEvents).where(eq(externalEvents.id, id));
    expect(row.status).toBe("FAILED");
  });
});

describe("GET /api/ops/events", () => {
  it("lists metadata, delivery count, sanitized last error and linked transactions; never the payload", async () => {
    const id = await insertEvent({ status: "FAILED", attempts: 3, lastError: "PermanentEventError: amount differs" });
    const transactionId = await createTransaction(db);
    await db.update(externalEvents).set({ transactionId }).where(eq(externalEvents.id, id));
    const tracedId = await createTransaction(db);
    await withTransaction(db, (tx) =>
      appendTraceEvent(tx, { accountId: SEED.accountId, transactionId: tracedId, kind: "STATUS_CHANGED", toStatus: "PENDING", externalEventId: id }),
    );
    await db.insert(eventDeliveries).values([
      { externalEventId: id, isDuplicate: false, correlationId: newId() },
      { externalEventId: id, isDuplicate: true, correlationId: newId() },
    ]);

    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        id,
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        status: "FAILED",
        attempts: 3,
        lastError: "PermanentEventError: amount differs",
        deliveryCount: 2,
        transactionIds: [transactionId, tracedId].sort(),
      }),
    ]);
    expect(body.items[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(body)).not.toContain(PII);
  });

  it("filters by status, provider and type", async () => {
    const failed = await insertEvent({ status: "FAILED" });
    const increase = await insertEvent({ provider: "increase", eventType: "card_payment.updated", status: "PROCESSED" });
    await insertEvent({ status: "PROCESSED" });
    expect((await list("?status=FAILED")).body.items.map((e: { id: string }) => e.id)).toEqual([failed]);
    expect((await list("?provider=increase")).body.items.map((e: { id: string }) => e.id)).toEqual([increase]);
    expect((await list("?type=card_payment.updated&status=PROCESSED")).body.items.map((e: { id: string }) => e.id)).toEqual([increase]);
    expect((await list("?status=BOGUS")).status).toBe(400);
    expect((await list("?provider=paypal")).status).toBe(400);
  });

  it("pages newest first with a keyset cursor, ties broken by id, no row twice or skipped", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertEvent({ receivedAt: sql`now() - make_interval(mins => ${i})` }));
    // Two events received at the same instant, after the others.
    const sameTime = new Date(Date.now() + 60_000);
    ids.push(await insertEvent({ receivedAt: sameTime }), await insertEvent({ receivedAt: sameTime }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { status, body } = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((e: { id: string }) => e.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    const expected = [...[ids[4], ids[5]].sort().reverse(), ids[0], ids[1], ids[2], ids[3]];
    expect(seen).toEqual(expected);
    expect((await list("?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("GET /api/ops/events/:id", () => {
  it("shows deliveries, trace steps, transactions touched and the audit trail; payload withheld", async () => {
    const id = await insertEvent();
    const transactionId = await createTransaction(db);
    await withTransaction(db, (tx) =>
      appendTraceEvent(tx, { accountId: SEED.accountId, transactionId, kind: "STATUS_CHANGED", toStatus: "PENDING", externalEventId: id, providerRef: "ch_1" }),
    );
    await db.insert(eventDeliveries).values({ externalEventId: id, isDuplicate: false, correlationId: newId() });

    const { status, body } = await detail(id);
    expect(status).toBe(200);
    expect(body.payload).toBe("withheld");
    expect(JSON.stringify(body)).not.toContain(PII);
    expect(body.event).toMatchObject({ id, status: "RECEIVED", deliveryCount: 1, transactionIds: [transactionId] });
    expect(body.deliveries).toEqual([{ receivedAt: expect.any(String), isDuplicate: false }]);
    expect(body.steps).toEqual([expect.objectContaining({ transactionId, kind: "STATUS_CHANGED", toStatus: "PENDING", providerRef: "ch_1" })]);
    expect(body.transactions).toEqual([expect.objectContaining({ id: transactionId, accountId: SEED.accountId, type: "FUNDING" })]);
    expect(body.audit).toEqual([]);
  });

  it("404 for an unknown event, 400 for a malformed id", async () => {
    expect((await detail(newId())).status).toBe(404);
    expect((await detail("nope")).status).toBe(400);
  });
});

describe("POST /api/ops/events/:id/retry", () => {
  it("retries a FAILED event once, audits it, and answers 409 to the second click", async () => {
    const id = await insertEvent({ status: "FAILED", attempts: 10, claimToken: 10 });
    const first = await retry(id);
    expect(first).toEqual({ status: 200, body: { event: { id, status: "RETRY", attempts: 0, nextAttemptAt: expect.any(String) } } });
    const second = await retry(id);
    expect(second.status).toBe(409);
    expect(second.body.error).toEqual({ code: "event_not_retryable", message: "Only FAILED events can be retried; this one is RETRY" });

    const audit = await db.select().from(auditEvents);
    expect(audit).toEqual([expect.objectContaining({ actorId: SEED.opsUserId, action: "event.retry", entityId: id })]);
    expect((await detail(id)).body.audit).toEqual([expect.objectContaining({ actorId: SEED.opsUserId, action: "event.retry" })]);
  });

  it("409 for an event that isn't FAILED, 404 for an unknown one", async () => {
    const processed = await insertEvent({ status: "PROCESSED" });
    expect((await retry(processed)).body.error.code).toBe("event_not_retryable");
    expect((await retry(newId())).status).toBe(404);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("403 from another origin, changing nothing; same origin or no Origin goes ahead", async () => {
    const id = await insertEvent({ status: "FAILED" });
    const from = (origin: string) => json(handleRetryEvent(deps, request(`/api/ops/events/${id}/retry`, "POST", { origin }), { id }));
    expect(await from("https://evil.example")).toEqual({ status: 403, body: { error: { code: "cross_origin", message: "This request must come from the Trace app" } } });
    expect((await from("null")).status).toBe(403);
    const [row] = await db.select().from(externalEvents).where(eq(externalEvents.id, id));
    expect(row.status).toBe("FAILED");
    expect((await from("http://localhost")).status).toBe(200);
  });
});

describe("GET /api/ops/metrics", () => {
  it("returns flushed counters, events by status and given-up payments", async () => {
    await insertEvent({ status: "FAILED" });
    await insertEvent({ status: "FAILED" });
    await insertEvent({ status: "PROCESSED" });
    const transactionId = await createTransaction(db, { type: "OUTBOUND_PAYMENT", status: "PENDING" });
    await db.insert(payments).values({
      accountId: SEED.accountId,
      transactionId,
      recipient: "Globex",
      accountNumber: "1234567890",
      routingNumber: "101050001",
      amountCents: 1,
      submitGaveUpAt: sql`now()`,
    });
    countOutcome("events_processed_total", { provider: "stripe", type: "payment_intent.succeeded", outcome: "processed" }, 2);
    await flushCounters(db, logger);

    const { status, body } = await json(handleGetMetrics(deps, request("/api/ops/metrics")));
    expect(status).toBe(200);
    expect(body.counters).toEqual([
      { name: "events_processed_total", labels: { provider: "stripe", type: "payment_intent.succeeded", outcome: "processed" }, value: 2 },
    ]);
    expect(body.events.byStatus).toEqual({ RECEIVED: 0, PROCESSING: 0, PROCESSED: 1, RETRY: 0, FAILED: 2, IGNORED: 0 });
    expect(body.payments).toEqual({ pending: 0, oldestUnsubmittedAgeSeconds: null, givenUp: 1 });
  });
});
