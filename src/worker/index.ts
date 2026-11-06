import { setTimeout as sleep } from "node:timers/promises";
import { createDb, createPool } from "../db/client";
import { config } from "../lib/config";
import { safeErrorForLog } from "../lib/errors";
import { logger as rootLogger } from "../lib/logger";
import { newId } from "../lib/ids";
import { outboxBacklog } from "../services/payments";
import { claimNextEvent, processEvent } from "./events";
import { routing } from "./handlers";
import { configuredIncrease } from "./increase";
import { claimNextPayment, submitPayment } from "./payment-submitter";

// Longer than the longest single-event pass: fetch (10 s timeout) plus one processing
// transaction (10 s statement timeout, 30 s idle-in-transaction timeout).
const LEASE_SECONDS = 120;
const IDLE_POLL_MS = 1_000;
const ERROR_PAUSE_MS = 5_000;
// How often the worker logs the payment outbox backlog (alert on the oldest unsubmitted payment).
const BACKLOG_LOG_MS = 60_000;

const log = rootLogger.child({ service: "worker", worker_id: newId() });
const pool = createPool(config().DATABASE_URL);
const db = createDb(pool);
const shutdown = new AbortController();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutdown requested; finishing the current event");
    shutdown.abort();
  });
}

async function pause(ms: number): Promise<void> {
  await sleep(ms, undefined, { signal: shutdown.signal }).catch(() => undefined);
}

async function logBacklog(): Promise<void> {
  const { pending, oldestAgeSeconds, givenUp } = await outboxBacklog(db);
  log.info(
    { outbox: "payments", pending_payments: pending, oldest_unsubmitted_payment_age_seconds: oldestAgeSeconds, given_up_payments: givenUp },
    "payment outbox backlog",
  );
}

log.info({ lease_seconds: LEASE_SECONDS }, "worker started");
let backlogLoggedAt = 0;
while (!shutdown.signal.aborted) {
  try {
    if (Date.now() - backlogLoggedAt >= BACKLOG_LOG_MS) {
      backlogLoggedAt = Date.now();
      await logBacklog();
    }
    // One event and one payment per pass, so neither queue starves the other.
    const event = await claimNextEvent(db, { leaseSeconds: LEASE_SECONDS });
    if (event) await processEvent(db, event, routing, log);
    const payment = await claimNextPayment(db, { leaseSeconds: LEASE_SECONDS });
    if (payment) await submitPayment(db, payment, configuredIncrease(), log);
    if (!event && !payment) await pause(IDLE_POLL_MS);
  } catch (error) {
    log.error({ err: safeErrorForLog(error) }, "worker loop error; pausing");
    await pause(ERROR_PAUSE_MS);
  }
}
await pool.end();
log.info("worker stopped");
