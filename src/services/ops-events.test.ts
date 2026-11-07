import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, externalEvents } from "../db/schema";
import { SEED } from "../db/seed";
import { createTestDb, resetDb } from "../db/test-helpers";
import { PermanentEventError } from "../lib/errors";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { claimNextEvent, processEvent } from "../worker/events";
import { handlerKey, type EventHandler } from "../worker/handlers";
import { flushCounters, readCounters } from "./metrics";
import { EVENT_AUDIT_ENTITY, EVENT_RETRY_ACTION, retryEvent } from "./ops-events";

const { pool, db } = createTestDb();
const routing = (handler: EventHandler) => ({ handlers: { [handlerKey("test", "thing.happened")]: handler }, ignored: {} });

async function insertEvent(values: Partial<typeof externalEvents.$inferInsert> = {}) {
  const [{ id }] = await db
    .insert(externalEvents)
    .values({ provider: "test", externalEventId: `evt_${newId()}`, eventType: "thing.happened", payload: {}, correlationId: newId(), ...values })
    .returning({ id: externalEvents.id });
  return id;
}

async function eventRow(id: string) {
  const [row] = await db.select().from(externalEvents).where(eq(externalEvents.id, id));
  return row;
}

async function runWorkerOnce(handler: EventHandler) {
  const claimed = await claimNextEvent(db, { leaseSeconds: 60 });
  if (!claimed) throw new Error("expected a due event");
  return processEvent(db, claimed, routing(handler), logger);
}

const retry = (eventId: string) => retryEvent(db, { eventId, userId: SEED.opsUserId, correlationId: newId() });

beforeEach(async () => {
  await flushCounters(db, logger);
  await resetDb(db);
});
afterAll(() => pool.end());

describe("retryEvent", () => {
  it("FAILED → RETRY → reprocessed by the worker, with an audit row written in the same transaction", async () => {
    const id = await insertEvent();
    let fixed = false;
    const handler: EventHandler = {
      apply: async () => {
        if (!fixed) throw new PermanentEventError("not modelled yet");
      },
    };
    expect(await runWorkerOnce(handler)).toBe("failed");
    const failed = await eventRow(id);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1, claimToken: 1 });

    const correlationId = newId();
    const result = await retryEvent(db, { eventId: id, userId: SEED.opsUserId, correlationId });
    expect(result).toMatchObject({ outcome: "retried", event: { id, status: "RETRY", attempts: 0 } });
    expect(await eventRow(id)).toMatchObject({ status: "RETRY", attempts: 0, claimToken: 2, lastError: failed.lastError });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit).toEqual([
      expect.objectContaining({
        actorType: "USER",
        actorId: SEED.opsUserId,
        action: EVENT_RETRY_ACTION,
        entityType: EVENT_AUDIT_ENTITY,
        previousState: { status: "FAILED", attempts: 1, claimToken: 1 },
        newState: { status: "RETRY", attempts: 0, claimToken: 2 },
        correlationId,
      }),
    ]);

    fixed = true;
    expect(await runWorkerOnce(handler)).toBe("processed");
    expect(await eventRow(id)).toMatchObject({ status: "PROCESSED", attempts: 1, claimToken: 3, lastError: null });
  });

  it("a second retry is not_retryable and never resets twice", async () => {
    const id = await insertEvent({ status: "FAILED", attempts: 10, claimToken: 10, lastError: "Error: boom" });
    expect((await retry(id)).outcome).toBe("retried");
    expect(await retry(id)).toEqual({ outcome: "not_retryable", status: "RETRY" });
    expect(await eventRow(id)).toMatchObject({ status: "RETRY", attempts: 0, claimToken: 11 });
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("concurrent retries: exactly one wins", async () => {
    const id = await insertEvent({ status: "FAILED", attempts: 10, claimToken: 10 });
    const other = createTestDb(5);
    try {
      const results = await Promise.all([
        retry(id),
        retryEvent(other.db, { eventId: id, userId: SEED.opsUserId, correlationId: newId() }),
        retry(id),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["not_retryable", "not_retryable", "retried"]);
    } finally {
      await other.pool.end();
    }
    expect(await eventRow(id)).toMatchObject({ status: "RETRY", attempts: 0, claimToken: 11 });
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("only FAILED is retryable; nothing changes and nothing is audited otherwise", async () => {
    for (const status of ["RECEIVED", "PROCESSING", "PROCESSED", "RETRY", "IGNORED"] as const) {
      const id = await insertEvent({ status, attempts: 2, claimToken: 2 });
      expect(await retry(id)).toEqual({ outcome: "not_retryable", status });
      expect(await eventRow(id)).toMatchObject({ status, attempts: 2, claimToken: 2 });
    }
    expect(await retry(newId())).toEqual({ outcome: "not_found" });
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("counts each outcome", async () => {
    const id = await insertEvent({ status: "FAILED" });
    await retry(id);
    await retry(id);
    await flushCounters(db, logger);
    const rows = (await readCounters(db)).filter((row) => row.name === "ops_event_retries_total");
    expect(rows.map((row) => [row.labels.outcome, row.value])).toEqual([
      ["not_retryable", 1],
      ["retried", 1],
    ]);
  });
});
