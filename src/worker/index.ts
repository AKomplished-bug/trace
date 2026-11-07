import { setTimeout as sleep } from "node:timers/promises";
import { createDb, createPool } from "../db/client";
import { config } from "../lib/config";
import { safeErrorForLog } from "../lib/errors";
import { logger as rootLogger } from "../lib/logger";
import { newId } from "../lib/ids";
import { INCREASE_PROVIDER } from "../integrations/increase";
import { STRIPE_PROVIDER } from "../integrations/stripe";
import { flushCounters, startCounterFlush } from "../services/metrics";
import { outboxBacklog } from "../services/payments";
import { claimNextRun, executeRun, type ReconciliationSources } from "../services/reconciliation";
import { claimNextEvent, processEvent } from "./events";
import { routing } from "./handlers";
import { configuredIncrease } from "./increase";
import { claimNextPayment, submitPayment } from "./payment-submitter";
import { configuredStripe } from "./stripe";

// Longer than the longest single-event pass: fetch (10 s timeout) plus one processing
// transaction (10 s statement timeout, 30 s idle-in-transaction timeout). Also longer than a
// reconciliation run: its fetch phase (60 s deadline) plus one transaction.
const LEASE_SECONDS = 120;
const IDLE_POLL_MS = 1_000;
const ERROR_PAUSE_MS = 5_000;
// How often the reconciliation loop looks for a due run when there is none.
const RUN_POLL_MS = 5_000;
// How often the worker logs the payment outbox backlog (alert on the oldest unsubmitted payment).
const BACKLOG_LOG_MS = 60_000;

const log = rootLogger.child({ service: "worker", worker_id: newId() });
const pool = createPool(config().DATABASE_URL);
const db = createDb(pool);
const shutdown = new AbortController();
// Reconciliation runs read the provider's own records through the configured adapters.
const reconciliationSources: ReconciliationSources = {
  [STRIPE_PROVIDER]: { payments: configuredStripe() },
  [INCREASE_PROVIDER]: { cards: configuredIncrease(), transfers: configuredIncrease() },
};
const reconciledProviders = Object.keys(reconciliationSources);

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

/**
 * Reconciliation runs in its own loop in this process, so a run's fetch (up to 60 s) never holds
 * up webhook events or payment submission in the main loop.
 */
async function reconciliationLoop(): Promise<void> {
  while (!shutdown.signal.aborted) {
    try {
      const run = await claimNextRun(db, { leaseSeconds: LEASE_SECONDS, providers: reconciledProviders });
      if (run) await executeRun(db, run, reconciliationSources, log);
      else await pause(RUN_POLL_MS);
    } catch (error) {
      log.error({ err: safeErrorForLog(error) }, "reconciliation loop error; pausing");
      await pause(ERROR_PAUSE_MS);
    }
  }
}

log.info({ lease_seconds: LEASE_SECONDS }, "worker started");
startCounterFlush(db, log, shutdown.signal);
const reconciling = reconciliationLoop();
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
// Let a reconciliation run in progress finish before closing the pool.
await reconciling;
await flushCounters(db, log);
await pool.end();
log.info("worker stopped");
