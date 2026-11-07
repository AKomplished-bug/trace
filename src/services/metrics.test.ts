import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createPool } from "../db/client";
import { externalEvents } from "../db/schema";
import { createTestDb, resetDb } from "../db/test-helpers";
import { PermanentEventError } from "../lib/errors";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";
import { claimNextEvent, processEvent } from "../worker/events";
import { handlerKey, type EventHandler } from "../worker/handlers";
import { countOutcome, flushCounters, readCounters } from "./metrics";

const { pool, db } = createTestDb();
const routing = (handler: EventHandler) => ({ handlers: { [handlerKey("test", "thing.happened")]: handler }, ignored: {} });

async function processOne(handler: EventHandler) {
  const [{ id }] = await db
    .insert(externalEvents)
    .values({ provider: "test", externalEventId: `evt_${newId()}`, eventType: "thing.happened", payload: {}, correlationId: newId() })
    .returning({ id: externalEvents.id });
  const claimed = await claimNextEvent(db, { leaseSeconds: 60 });
  if (!claimed) throw new Error("expected a due event");
  const outcome = await processEvent(db, claimed, routing(handler), logger);
  return { id, outcome };
}

async function counter(name: string) {
  return (await readCounters(db)).filter((row) => row.name === name);
}

/** A database whose every query fails, as if Postgres were down. */
async function brokenDb() {
  const deadPool = createPool(process.env.DATABASE_URL_TEST ?? "", 1);
  await deadPool.end();
  return createDb(deadPool);
}

beforeEach(async () => {
  await flushCounters(db, logger); // drop what earlier tests buffered
  await resetDb(db);
});
afterAll(() => pool.end());

describe("outcome counters", () => {
  it("adds every flush to the stored value, one row per label set whatever the key order", async () => {
    countOutcome("demo_total", { a: "1", b: "2" }, 3);
    countOutcome("demo_total", { b: "2", a: "1" });
    countOutcome("demo_total", { a: "other", b: "2" });
    expect(await flushCounters(db, logger)).toBe(true);
    countOutcome("demo_total", { a: "1", b: "2" }, 2);
    expect(await flushCounters(db, logger)).toBe(true);
    expect(await counter("demo_total")).toEqual([
      { name: "demo_total", labels: { a: "1", b: "2" }, value: 6 },
      { name: "demo_total", labels: { a: "other", b: "2" }, value: 1 },
    ]);
  });

  it("a failed counter write never fails the event, and the counts survive to the next flush", async () => {
    const { id, outcome } = await processOne({ apply: async () => {} });
    expect(outcome).toBe("processed");

    expect(await flushCounters(await brokenDb(), logger)).toBe(false);
    const [row] = await db.select().from(externalEvents).where(eq(externalEvents.id, id));
    expect(row.status).toBe("PROCESSED");
    expect(await counter("events_processed_total")).toEqual([]);

    expect(await flushCounters(db, logger)).toBe(true);
    expect(await counter("events_processed_total")).toEqual([
      { name: "events_processed_total", labels: { provider: "test", type: "thing.happened", outcome: "processed" }, value: 1 },
    ]);
  });

  it("drops what a handler counted when its transaction rolls back", async () => {
    const { outcome } = await processOne({
      apply: async () => {
        countOutcome("handler_effect_total", { outcome: "applied" });
        throw new Error("boom after counting");
      },
    });
    expect(outcome).toBe("retry");
    await flushCounters(db, logger);
    expect(await counter("handler_effect_total")).toEqual([]);
    expect(await counter("events_processed_total")).toEqual([
      { name: "events_processed_total", labels: { provider: "test", type: "thing.happened", outcome: "retry" }, value: 1 },
    ]);
  });

  it("keeps what a handler counted once its transaction commits", async () => {
    await processOne({ apply: async () => countOutcome("handler_effect_total", { outcome: "applied" }) });
    await flushCounters(db, logger);
    expect(await counter("handler_effect_total")).toEqual([{ name: "handler_effect_total", labels: { outcome: "applied" }, value: 1 }]);
  });

  it("labels a PermanentEventError failure as permanent", async () => {
    const { outcome } = await processOne({
      apply: async () => {
        throw new PermanentEventError("contradicts our records");
      },
    });
    expect(outcome).toBe("failed");
    await flushCounters(db, logger);
    expect(await counter("events_processed_total")).toEqual([
      { name: "events_processed_total", labels: { provider: "test", type: "thing.happened", outcome: "permanent" }, value: 1 },
    ]);
  });
});
