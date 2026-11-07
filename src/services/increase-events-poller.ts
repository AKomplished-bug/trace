import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { providerCursors } from "../db/schema";
import { INCREASE_PROVIDER } from "../integrations/increase";
import type { EventFeed } from "../integrations/payment-provider";
import { safeErrorForLog } from "../lib/errors";
import { newId } from "../lib/ids";
import type { Logger } from "../lib/logger";
import { ingestEvent } from "./ingestion";
import { countOutcome } from "./metrics";

/**
 * The Increase events poller: the missed-webhook safety net, and the only delivery path for a
 * sandbox that can't send webhooks. Each pass reads `GET /events` (the categories with handlers,
 * oldest first) from the stored cursor and feeds every event into `ingestEvent` like a verified
 * webhook; the worker's handlers take it from there.
 */

/**
 * Each pass re-reads this far behind the cursor. Increase's created_at has whole seconds, and an
 * event may become visible after a later one; ingestion deduplicates what was already read.
 */
export const POLL_OVERLAP_SECONDS = 60;
/**
 * With no cursor yet, the first pass starts this far back. `GET /events` covers the whole Increase
 * group (every account and card, not just ours), so we don't replay its history.
 */
export const POLL_START_LOOKBACK_SECONDS = 60 * 60;
/** Pages (of 100) per pass; the rest is read on the next pass, from the saved cursor. */
export const POLL_MAX_PAGES = 10;
/** Deadline for one pass's reads; each call also has the adapter's 10 s timeout. */
export const POLL_DEADLINE_MS = 30_000;

export const POLL_COUNTER = "increase_events_polled_total";

export interface ClaimedCursor {
  claimToken: number;
  lastEventCreatedAt: Date | null;
  lastExternalEventId: string | null;
}

export type PollOutcome = "polled" | "busy" | "lease_lost" | "error";

export interface PollResult {
  outcome: PollOutcome;
  counts: { new: number; duplicate: number; already_polled: number };
  /** The page cap or deadline stopped the pass with events left to read. */
  more: boolean;
}

/**
 * Claims the provider's cursor row (creating it the first time) unless another worker's lease is
 * live: autocommitted, so no lock is held during the provider calls; every later write is fenced
 * on the returned `claimToken`.
 */
export async function claimCursor(db: Db, provider: string, leaseSeconds: number): Promise<ClaimedCursor | null> {
  const { rows } = await db.execute<{ claim_token: number; last_event_created_at: Date | null; last_external_event_id: string | null }>(sql`
    INSERT INTO ${providerCursors} (provider, claim_token, lease_until)
    VALUES (${provider}, 1, now() + make_interval(secs => ${leaseSeconds}))
    ON CONFLICT (provider) DO UPDATE
    SET claim_token = ${providerCursors}.claim_token + 1, lease_until = EXCLUDED.lease_until, updated_at = now()
    WHERE ${providerCursors}.lease_until IS NULL OR ${providerCursors}.lease_until <= now()
    RETURNING claim_token, last_event_created_at, last_external_event_id
  `);
  const row = rows[0];
  if (!row) return null;
  return { claimToken: row.claim_token, lastEventCreatedAt: row.last_event_created_at && new Date(row.last_event_created_at), lastExternalEventId: row.last_external_event_id };
}

/** Moves the cursor, only while `claimToken` is still the latest claim; false if it isn't. */
export async function advanceCursor(db: Db, provider: string, claimToken: number, to: { createdAt: Date; externalEventId: string }): Promise<boolean> {
  const { rowCount } = await db.execute(sql`
    UPDATE ${providerCursors}
    SET last_event_created_at = ${to.createdAt.toISOString()}, last_external_event_id = ${to.externalEventId}, updated_at = now()
    WHERE provider = ${provider} AND claim_token = ${claimToken}
  `);
  return rowCount === 1;
}

async function releaseCursor(db: Db, provider: string, claimToken: number): Promise<void> {
  await db.execute(sql`UPDATE ${providerCursors} SET lease_until = NULL WHERE provider = ${provider} AND claim_token = ${claimToken}`);
}

/**
 * One pass. Never throws: a failure is logged and counted (`error`), and what earlier pages
 * ingested stays ingested, with the cursor at their last event. Counts per event `new` (stored
 * here first), `duplicate` (a webhook stored it first; this poll is recorded as a second delivery)
 * and `already_polled` (re-read in the overlap; no delivery row); per pass `error` and `lease_lost`.
 */
export async function pollIncreaseEvents(
  db: Db,
  feed: EventFeed,
  logger: Logger,
  { leaseSeconds, maxPages = POLL_MAX_PAGES, deadlineMs = POLL_DEADLINE_MS }: { leaseSeconds: number; maxPages?: number; deadlineMs?: number },
): Promise<PollResult> {
  const provider = INCREASE_PROVIDER;
  const correlationId = newId();
  const log = logger.child({ correlation_id: correlationId, provider, job: "events_poll" });
  const counts = { new: 0, duplicate: 0, already_polled: 0 };
  let claim: ClaimedCursor | null = null;
  try {
    claim = await claimCursor(db, provider, leaseSeconds);
    if (!claim) return { outcome: "busy", counts, more: false };
    const signal = AbortSignal.timeout(deadlineMs);
    let newest = claim.lastEventCreatedAt;
    const since = newest ? new Date(newest.getTime() - POLL_OVERLAP_SECONDS * 1000) : new Date(Date.now() - POLL_START_LOOKBACK_SECONDS * 1000);
    let cursor: string | undefined;
    for (let page = 1; page <= maxPages && !signal.aborted; page++) {
      const { events, nextCursor, requestId } = await feed.listEvents({ since, cursor }, signal);
      for (const event of events) {
        const ingested = await ingestEvent(db, provider, event, correlationId, "poll");
        const outcome = !ingested.duplicate ? "new" : ingested.deliveryRecorded ? "duplicate" : "already_polled";
        counts[outcome]++;
        countOutcome(POLL_COUNTER, { outcome });
        if (outcome !== "already_polled") {
          log.info(
            { outcome, event_id: ingested.eventId, external_event_id: event.externalEventId, event_type: event.eventType, provider_request_id: requestId },
            outcome === "new" ? "polled event stored" : "polled event already stored by a webhook; delivery recorded",
          );
        }
      }
      // Oldest first, so the page's last event is the newest read so far unless the page was all overlap.
      const last = events.at(-1);
      if (last && (!newest || last.createdAt >= newest)) {
        if (!(await advanceCursor(db, provider, claim.claimToken, { createdAt: last.createdAt, externalEventId: last.externalEventId }))) {
          countOutcome(POLL_COUNTER, { outcome: "lease_lost" });
          log.warn({ outcome: "lease_lost", page }, "events poll lost its claim on the cursor; stopping");
          return { outcome: "lease_lost", counts, more: true };
        }
        newest = last.createdAt;
      }
      log.debug({ page, events: events.length, provider_request_id: requestId }, "events page read");
      if (!nextCursor) {
        if (counts.new + counts.duplicate > 0) log.info({ outcome: "polled", ...counts, cursor_created_at: newest?.toISOString() }, "events poll done");
        return { outcome: "polled", counts, more: false };
      }
      cursor = nextCursor;
    }
    log.info({ outcome: "polled", ...counts, cursor_created_at: newest?.toISOString() }, "events poll stopped at its page cap or deadline; continuing next pass");
    return { outcome: "polled", counts, more: true };
  } catch (error) {
    countOutcome(POLL_COUNTER, { outcome: "error" });
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    log.error({ outcome: "error", ...counts, err: safeErrorForLog(error), provider_request_id: requestId }, "events poll failed; retrying next pass");
    return { outcome: "error", counts, more: false };
  } finally {
    if (claim) {
      await releaseCursor(db, provider, claim.claimToken).catch((error: unknown) =>
        log.error({ err: safeErrorForLog(error) }, "events poll could not release its cursor lease; it expires on its own"),
      );
    }
  }
}
