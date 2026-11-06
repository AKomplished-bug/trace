import { setTimeout as sleep } from "node:timers/promises";
import { createDb, createPool } from "../db/client";
import { config } from "../lib/config";
import { safeErrorForLog } from "../lib/errors";
import { logger as rootLogger } from "../lib/logger";
import { newId } from "../lib/ids";
import { claimNextEvent, processEvent } from "./events";
import { routing } from "./handlers";

// Longer than the longest single-event pass: fetch (10 s timeout) plus one processing
// transaction (10 s statement timeout, 30 s idle-in-transaction timeout).
const LEASE_SECONDS = 120;
const IDLE_POLL_MS = 1_000;
const ERROR_PAUSE_MS = 5_000;

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

log.info({ lease_seconds: LEASE_SECONDS }, "worker started");
while (!shutdown.signal.aborted) {
  try {
    const event = await claimNextEvent(db, { leaseSeconds: LEASE_SECONDS });
    if (event) await processEvent(db, event, routing, log);
    else await pause(IDLE_POLL_MS);
  } catch (error) {
    log.error({ err: safeErrorForLog(error) }, "worker loop error; pausing");
    await pause(ERROR_PAUSE_MS);
  }
}
await pool.end();
log.info("worker stopped");
