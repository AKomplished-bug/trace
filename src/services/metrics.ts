import { AsyncLocalStorage } from "node:async_hooks";
import { asc, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { metricCounters } from "../db/schema";
import { safeErrorForLog } from "../lib/errors";
import type { Logger } from "../lib/logger";

/**
 * Outcome counters (`events_processed_total{provider,type,outcome}` …) shared by the web and
 * worker processes. `countOutcome` only adds to an in-process buffer — no I/O, never throws — and
 * `flushCounters` adds the buffer to `metric_counters` every few seconds, outside any business
 * transaction. A failed flush keeps the counts for the next one, so a counter write can't fail the
 * work it counts. Label values must come from a fixed set (event types, outcome names), never ids.
 */

export type CounterLabels = Record<string, string>;

interface Pending {
  name: string;
  labels: CounterLabels;
  value: number;
}

const FLUSH_EVERY_MS = 5_000;

// On globalThis, not module scope: Next bundles route handlers and pages separately, each with its
// own copy of this module, and the one flush timer (started with apiDeps) must see every count.
const shared = globalThis as typeof globalThis & {
  traceCounters?: { buffer: Map<string, Pending>; uncommitted: AsyncLocalStorage<Map<string, Pending>> };
};
shared.traceCounters ??= { buffer: new Map(), uncommitted: new AsyncLocalStorage() };
const buffer = shared.traceCounters.buffer;
// Counts made inside a processing transaction, held until it commits (see countAfterCommit).
const uncommitted = shared.traceCounters.uncommitted;

function keyOf(name: string, labels: CounterLabels): string {
  return JSON.stringify([name, Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}

function add(into: Map<string, Pending>, name: string, labels: CounterLabels, value: number): void {
  const key = keyOf(name, labels);
  const pending = into.get(key);
  if (pending) pending.value += value;
  else into.set(key, { name, labels, value });
}

/** The one way to count an outcome. Inside `countAfterCommit`, it counts only if that work commits. */
export function countOutcome(name: string, labels: CounterLabels = {}, value = 1): void {
  add(uncommitted.getStore() ?? buffer, name, labels, value);
}

/**
 * Runs `work` (a database transaction) and keeps the counts made inside it only if it returns, so
 * an outcome counted in a transaction that rolls back (and is retried) isn't counted twice.
 */
export async function countAfterCommit<T>(work: () => Promise<T>): Promise<T> {
  const pending = new Map<string, Pending>();
  const result = await uncommitted.run(pending, work);
  for (const { name, labels, value } of pending.values()) countOutcome(name, labels, value);
  return result;
}

/**
 * Adds the buffered counts to `metric_counters` in one statement; false if that failed (the counts
 * stay buffered and are logged, never thrown). Rows go in key order, so two processes flushing at
 * once take the row locks in the same order and can't deadlock.
 */
export async function flushCounters(db: Db, log: Logger): Promise<boolean> {
  if (buffer.size === 0) return true;
  const rows = [...buffer.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  buffer.clear();
  try {
    await db
      .insert(metricCounters)
      .values(rows)
      .onConflictDoUpdate({
        target: [metricCounters.name, metricCounters.labels],
        set: { value: sql`${metricCounters.value} + excluded.value`, updatedAt: sql`now()` },
      });
    return true;
  } catch (error) {
    for (const { name, labels, value } of rows) add(buffer, name, labels, value);
    log.warn({ outcome: "counter_flush_failed", err: safeErrorForLog(error), counters: rows.length }, "counter flush failed; kept for the next flush");
    return false;
  }
}

/** Flushes every few seconds until `signal` aborts; the timer doesn't keep the process alive. */
export function startCounterFlush(db: Db, log: Logger, signal?: AbortSignal): void {
  let flushing = false;
  const timer = setInterval(() => {
    if (flushing) return;
    flushing = true;
    void flushCounters(db, log).finally(() => {
      flushing = false;
    });
  }, FLUSH_EVERY_MS);
  timer.unref();
  signal?.addEventListener("abort", () => clearInterval(timer), { once: true });
}

/** Every counter's flushed value, by name then labels. */
export async function readCounters(db: Db) {
  return db
    .select({ name: metricCounters.name, labels: metricCounters.labels, value: metricCounters.value })
    .from(metricCounters)
    .orderBy(asc(metricCounters.name), asc(sql`${metricCounters.labels}::text`));
}
