import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/client";
import { businesses, externalEvents, users } from "../db/schema";
import { createTestDb, resetDb } from "../db/test-helpers";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { backoffMs, claimNextEvent, MAX_ATTEMPTS, processEvent } from "./events";
import { handlerKey, type EventHandler, type EventRouting } from "./handlers";

const { pool, db } = createTestDb();
const LEASE = { leaseSeconds: 60 };
const KEY = handlerKey("test", "thing.happened");

function routingWith(handler: EventHandler, ignored: EventRouting["ignored"] = {}): EventRouting {
  return { handlers: { [KEY]: handler }, ignored };
}
const noRouting: EventRouting = { handlers: {}, ignored: {} };

async function insertEvents(count: number, values: Partial<PgInsertValue<typeof externalEvents>> = {}) {
  const rows = await db
    .insert(externalEvents)
    .values(
      Array.from({ length: count }, (_, i) => ({
        provider: "test",
        externalEventId: `evt_${i}_${newId()}`,
        eventType: "thing.happened",
        payload: { i },
        correlationId: newId(),
        ...values,
      })),
    )
    .returning({ id: externalEvents.id });
  return rows.map((r) => r.id);
}

async function eventRow(id: string) {
  const [row] = await db.select().from(externalEvents).where(eq(externalEvents.id, id));
  return row;
}

async function claim() {
  const event = await claimNextEvent(db, LEASE);
  if (!event) throw new Error("expected a due event");
  return event;
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe("claimNextEvent", () => {
  it("never hands the same event to two racing claimers", async () => {
    const ids = await insertEvents(50);
    const other = createTestDb(5);
    const drain = async (claimDb: typeof db) => {
      const seen: string[] = [];
      for (let event = await claimNextEvent(claimDb, LEASE); event; event = await claimNextEvent(claimDb, LEASE)) {
        seen.push(event.id);
      }
      return seen;
    };
    try {
      const [a, b] = await Promise.all([drain(db), drain(other.db)]);
      const all = [...a, ...b];
      expect(all).toHaveLength(50);
      expect(new Set(all)).toEqual(new Set(ids));
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
    } finally {
      await other.pool.end();
    }
    const rows = await db.select().from(externalEvents);
    expect(rows.every((r) => r.status === "PROCESSING" && r.attempts === 1 && r.claimToken === 1)).toBe(true);
  });

  it("skips events that aren't due, are finished, or are still leased", async () => {
    await insertEvents(1, { nextAttemptAt: sql`now() + interval '1 hour'` });
    await insertEvents(1, { status: "PROCESSED" });
    await insertEvents(1, { status: "FAILED" });
    await insertEvents(1, { status: "IGNORED" });
    await insertEvents(1, { status: "PROCESSING", attempts: 1, claimToken: 1, nextAttemptAt: sql`now() + interval '1 minute'` });
    expect(await claimNextEvent(db, LEASE)).toBeNull();
  });

  it("reclaims a PROCESSING event whose lease expired, with a new claim token", async () => {
    const [id] = await insertEvents(1, {
      status: "PROCESSING",
      attempts: 1,
      claimToken: 1,
      nextAttemptAt: sql`now() - interval '1 second'`,
    });
    expect(await claimNextEvent(db, LEASE)).toMatchObject({ id, attempts: 2, claimToken: 2 });
  });
});

describe("processEvent", () => {
  it("retries event types without a handler, so they surface instead of vanishing", async () => {
    const [id] = await insertEvents(1);
    expect(await processEvent(db, await claim(), noRouting, logger)).toBe("retry");
    expect(await eventRow(id)).toMatchObject({
      status: "RETRY",
      attempts: 1,
      lastError: "no handler registered for test:thing.happened",
    });
  });

  it("marks only explicitly ignored types IGNORED", async () => {
    const [id] = await insertEvents(1);
    const routing: EventRouting = { handlers: {}, ignored: { test: ["thing.happened"] } };
    expect(await processEvent(db, await claim(), routing, logger)).toBe("ignored");
    const row = await eventRow(id);
    expect(row.status).toBe("IGNORED");
    expect(row.processedAt).not.toBeNull();
  });

  it("runs fetch with no transaction open, then apply with its result, and marks PROCESSED", async () => {
    const [id] = await insertEvents(1);
    const probe = createTestDb(1);
    let openTransactions = -1;
    try {
      const routing = routingWith({
        async fetch(event) {
          // No session (ours or any other) is inside a transaction, and the event row isn't locked.
          const { rows } = await db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()`,
          );
          openTransactions = rows[0].n;
          await withTransaction(probe.db, (tx) =>
            tx.execute(sql`SELECT id FROM ${externalEvents} WHERE id = ${event.id} FOR UPDATE NOWAIT`),
          );
          return { name: `from ${event.externalEventId}` };
        },
        async apply(tx, _event, fetched: { name: string }) {
          await tx.insert(businesses).values({ name: fetched.name });
        },
      } satisfies EventHandler<{ name: string }>);
      expect(await processEvent(db, await claim(), routing, logger)).toBe("processed");
    } finally {
      await probe.pool.end();
    }
    expect(openTransactions).toBe(0);
    expect((await eventRow(id)).status).toBe("PROCESSED");
    expect((await db.select().from(businesses)).map((b) => b.name)).toContainEqual(expect.stringMatching(/^from evt_0_/));
  });

  it("retries when fetch fails or times out, without running apply", async () => {
    const [id] = await insertEvents(1);
    let applied = false;
    let fetchSignal: AbortSignal | undefined;
    const routing = routingWith({
      fetch: (_event, _log, signal) => {
        fetchSignal = signal;
        return new Promise(() => undefined);
      },
      async apply() {
        applied = true;
      },
    });
    expect(await processEvent(db, await claim(), routing, logger, { fetchTimeoutMs: 50 })).toBe("retry");
    expect(applied).toBe(false);
    expect(fetchSignal?.aborted).toBe(true);
    expect((await eventRow(id)).lastError).toBe("FetchTimeoutError: fetch timed out after 50 ms");
  });

  it("rolls back apply's writes and schedules a retry with backoff on failure", async () => {
    const [id] = await insertEvents(1);
    const routing = routingWith({
      async apply(tx) {
        await tx.insert(businesses).values({ name: "half-done" });
        throw new Error("settlement arrived before authorization");
      },
    });
    expect(await processEvent(db, await claim(), routing, logger)).toBe("retry");
    const row = await eventRow(id);
    expect(row).toMatchObject({ status: "RETRY", attempts: 1, lastError: "Error: settlement arrived before authorization" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(businesses)).toHaveLength(1);
  });

  it("stores database errors without row values", async () => {
    const [id] = await insertEvents(1);
    const routing = routingWith({
      async apply(tx) {
        await tx.insert(users).values({ email: "ops@trace.test", name: "Dup", role: "OPS" });
      },
    });
    expect(await processEvent(db, await claim(), routing, logger)).toBe("retry");
    const { lastError } = await eventRow(id);
    expect(lastError).toBe("DatabaseError 23505 (unique violation) constraint=users_email_unique table=users");
  });

  it("marks the event FAILED after the last attempt", async () => {
    const [id] = await insertEvents(1, { status: "RETRY", attempts: MAX_ATTEMPTS - 1, claimToken: MAX_ATTEMPTS - 1 });
    const routing = routingWith({
      async apply() {
        throw new Error("still broken");
      },
    });
    expect(await processEvent(db, await claim(), routing, logger)).toBe("failed");
    expect(await eventRow(id)).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS, lastError: "Error: still broken" });
  });

  it("fails an event whose earlier attempts never finished, without running it again", async () => {
    const [id] = await insertEvents(1, {
      status: "PROCESSING",
      attempts: MAX_ATTEMPTS,
      claimToken: MAX_ATTEMPTS,
      nextAttemptAt: sql`now() - interval '1 second'`,
    });
    let calls = 0;
    const routing = routingWith({
      async apply() {
        calls++;
      },
    });
    expect(await processEvent(db, await claim(), routing, logger)).toBe("failed");
    expect(calls).toBe(0);
    expect((await eventRow(id)).status).toBe("FAILED");
  });

  it("does nothing when another worker took over the claim", async () => {
    const [id] = await insertEvents(1);
    let calls = 0;
    const routing = routingWith({
      async apply() {
        calls++;
      },
    });
    const stale = await claim();
    // The lease expires and another worker reclaims the event (claim token 2).
    await db.update(externalEvents).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(externalEvents.id, id));
    const fresh = await claim();
    expect(await processEvent(db, stale, routing, logger)).toBe("lease_lost");
    expect(calls).toBe(0);
    expect(await processEvent(db, fresh, routing, logger)).toBe("processed");
    expect(await eventRow(id)).toMatchObject({ status: "PROCESSED", attempts: 2, claimToken: 2 });
  });
});

describe("backoffMs", () => {
  it("doubles from 5 s and caps at 15 minutes", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(20)).toBe(15 * 60_000);
  });

  it("spreads MAX_ATTEMPTS over roughly half an hour", () => {
    const totalMs = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1)).reduce((a, b) => a + b, 0);
    expect(totalMs).toBe(2_175_000);
  });
});
