import { and, eq, sql } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { externalEvents } from "../db/schema";
import { NotOursEventError, PermanentEventError, safeErrorForLog, safeErrorMessage } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { countAfterCommit, countOutcome } from "../services/metrics";
import { handlerKey, type EventRouting } from "./handlers";

/** 10 attempts with backoff 5 s, 10 s … capped at 15 min: about 36 minutes before FAILED. */
export const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60_000;
/** Default deadline for a handler's `fetch` phase (provider calls). */
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1_000;

/** Delay before the next attempt after `attempts` failures: 5 s, 10 s, 20 s … capped at 15 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

export interface ClaimedEvent {
  id: string;
  provider: string;
  eventType: string;
  /** Claims so far, including this one; the retry budget. */
  attempts: number;
  /** Fencing token of this claim; every later update requires it to still match. */
  claimToken: number;
  correlationId: string;
}

/**
 * Atomically claims the oldest due event: RECEIVED/RETRY whose next_attempt_at has passed, or
 * PROCESSING whose lease expired (its worker died). Claiming sets PROCESSING, bumps attempts and
 * claim_token, and sets next_attempt_at to the lease expiry. One event per claim, so a poison
 * event can't use up other events' attempts. SKIP LOCKED lets workers claim concurrently.
 */
export async function claimNextEvent(db: Db, { leaseSeconds }: { leaseSeconds: number }): Promise<ClaimedEvent | null> {
  const { rows } = await db.execute<{
    id: string;
    provider: string;
    event_type: string;
    attempts: number;
    claim_token: number;
    correlation_id: string;
  }>(sql`
    UPDATE ${externalEvents}
    SET status = 'PROCESSING',
        attempts = attempts + 1,
        claim_token = claim_token + 1,
        next_attempt_at = now() + make_interval(secs => ${leaseSeconds})
    WHERE id = (
      SELECT id FROM ${externalEvents}
      WHERE status IN ('RECEIVED', 'RETRY', 'PROCESSING') AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, provider, event_type, attempts, claim_token, correlation_id
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.event_type,
    attempts: row.attempts,
    claimToken: row.claim_token,
    correlationId: row.correlation_id,
  };
}

export type ProcessOutcome = "processed" | "ignored" | "not_ours" | "retry" | "failed" | "lease_lost";

class LeaseLostError extends Error {}

class FetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`fetch timed out after ${ms} ms`);
    this.name = "FetchTimeoutError";
  }
}

/** Our claim on the event, unchanged since we took it. */
function claimed(event: ClaimedEvent) {
  return and(
    eq(externalEvents.id, event.id),
    eq(externalEvents.status, "PROCESSING"),
    eq(externalEvents.claimToken, event.claimToken),
  );
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Processes one claimed event: `fetch` outside any transaction, then `apply` and the PROCESSED
 * mark in one transaction. Explicitly ignored types, and events a handler finds aren't about our
 * objects (`NotOursEventError`), are IGNORED; types without a handler and failures go to RETRY
 * with backoff, or FAILED after MAX_ATTEMPTS — or at once for a `PermanentEventError`.
 */
export async function processEvent(
  db: Db,
  event: ClaimedEvent,
  routing: EventRouting,
  logger: Logger,
  { fetchTimeoutMs = FETCH_TIMEOUT_MS }: { fetchTimeoutMs?: number } = {},
): Promise<ProcessOutcome> {
  const log = logger.child({
    event_id: event.id,
    correlation_id: event.correlationId,
    provider: event.provider,
    event_type: event.eventType,
    attempt: event.attempts,
  });

  if (routing.ignored[event.provider]?.includes(event.eventType)) {
    const updated = await db
      .update(externalEvents)
      .set({ status: "IGNORED", processedAt: sql`now()`, lastError: null })
      .where(claimed(event))
      .returning({ id: externalEvents.id });
    const outcome = updated.length ? "ignored" : "lease_lost";
    countProcessed(event, outcome);
    log.info({ outcome }, "event type ignored for this provider");
    return outcome;
  }

  const key = handlerKey(event.provider, event.eventType);
  const handler = routing.handlers[key];
  if (!handler) return fail(db, event, log, `no handler registered for ${key}`);

  // Claimed more than MAX_ATTEMPTS times means earlier attempts never finished (crash or lease expiry).
  if (event.attempts > MAX_ATTEMPTS) {
    const reason = `gave up after ${MAX_ATTEMPTS} attempts; the last ones did not finish (worker crash or lease expiry)`;
    return fail(db, event, log, reason);
  }

  try {
    // Phase 1, no transaction open: re-read the event and run provider calls.
    const [current] = await db.select().from(externalEvents).where(claimed(event));
    if (!current) throw new LeaseLostError();
    const fetchPhase = handler.fetch;
    const fetched = fetchPhase
      ? await withTimeout((signal) => fetchPhase.call(handler, current, log, signal), fetchTimeoutMs)
      : undefined;

    // Phase 2: effects and the PROCESSED mark commit together, only if we still own the claim.
    // Outcomes the handler counts are kept only if this transaction commits.
    await countAfterCommit(() =>
      withTransaction(db, async (tx) => {
        const [row] = await tx.select().from(externalEvents).where(claimed(event)).for("update");
        if (!row) throw new LeaseLostError();
        await handler.apply(tx, row, fetched, log);
        await tx
          .update(externalEvents)
          .set({ status: "PROCESSED", processedAt: sql`now()`, lastError: null })
          .where(eq(externalEvents.id, event.id));
      }),
    );
    countProcessed(event, "processed");
    log.info({ outcome: "processed" }, "event processed");
    return "processed";
  } catch (error) {
    if (error instanceof LeaseLostError) {
      countProcessed(event, "lease_lost");
      log.warn({ outcome: "lease_lost" }, "event claim lost to another worker; skipped");
      return "lease_lost";
    }
    if (error instanceof NotOursEventError) return ignoreNotOurs(db, event, log, error);
    return fail(db, event, log, safeErrorMessage(error), error);
  }
}

/** IGNORED at once, never retried: the event is about an object that isn't ours. */
async function ignoreNotOurs(db: Db, event: ClaimedEvent, log: Logger, error: NotOursEventError): Promise<ProcessOutcome> {
  const reason = `not ours: ${safeErrorMessage(error)}`.slice(0, MAX_ERROR_LENGTH);
  const updated = await db
    .update(externalEvents)
    .set({ status: "IGNORED", processedAt: sql`now()`, lastError: reason })
    .where(claimed(event))
    .returning({ id: externalEvents.id });
  const outcome = updated.length ? "not_ours" : "lease_lost";
  countProcessed(event, outcome);
  log.info({ outcome, error_message: reason }, "event is about an object that isn't ours; ignored");
  return outcome;
}

/** `events_processed_total{provider,type,outcome}`; outcome "permanent" is a FAILED from a PermanentEventError. */
function countProcessed(event: ClaimedEvent, outcome: ProcessOutcome | "permanent"): void {
  countOutcome("events_processed_total", { provider: event.provider, type: event.eventType, outcome });
}

async function fail(
  db: Db,
  event: ClaimedEvent,
  log: Logger,
  message: string,
  error?: unknown,
): Promise<ProcessOutcome> {
  const permanent = error instanceof PermanentEventError;
  const terminal = permanent || event.attempts >= MAX_ATTEMPTS;
  const delaySeconds = backoffMs(event.attempts) / 1000;
  const updated = await db
    .update(externalEvents)
    .set({
      status: terminal ? "FAILED" : "RETRY",
      nextAttemptAt: terminal ? sql`now()` : sql`now() + make_interval(secs => ${delaySeconds})`,
      lastError: message.slice(0, MAX_ERROR_LENGTH),
    })
    .where(claimed(event))
    .returning({ id: externalEvents.id });
  const err = error === undefined ? undefined : safeErrorForLog(error);
  if (!updated.length) {
    countProcessed(event, "lease_lost");
    log.warn({ outcome: "lease_lost", err, error_message: message }, "event failed after its claim was lost; left to the new owner");
    return "lease_lost";
  }
  const outcome = terminal ? "failed" : "retry";
  countProcessed(event, permanent ? "permanent" : outcome);
  log.error(
    { outcome, err, error_message: message, permanent, retry_in_seconds: terminal ? undefined : delaySeconds },
    terminal ? "event failed permanently" : "event failed; will retry",
  );
  return outcome;
}
