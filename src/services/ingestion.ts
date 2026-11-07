import { and, eq } from "drizzle-orm";
import { withTransaction, type Db } from "../db/client";
import { eventDeliveries, externalEvents } from "../db/schema";
import type { VerifiedWebhook } from "../integrations/payment-provider";

export type DeliverySource = "webhook" | "poll";

export interface IngestResult {
  eventId: string;
  /** The event was already stored by an earlier delivery; this one has no effect. */
  duplicate: boolean;
  /** False only when the poller had already read this event (its overlap window): no delivery row added. */
  deliveryRecorded: boolean;
}

/**
 * Stores a verified provider event and records this delivery, in one transaction. Inserting the
 * event is the enqueue (status RECEIVED, due now); a duplicate leaves the stored event untouched
 * and only adds a delivery row, so Ops can see "received twice, no effect". Webhooks and the
 * events poller (`source`) store the same payload here, so either may arrive first; every webhook is
 * a delivery, a poll only the first time it reads the event. Nothing else happens here — the worker
 * does the processing.
 */
export async function ingestEvent(
  db: Db,
  provider: string,
  webhook: VerifiedWebhook,
  correlationId: string,
  source: DeliverySource = "webhook",
): Promise<IngestResult> {
  return withTransaction(db, async (tx) => {
    const [inserted] = await tx
      .insert(externalEvents)
      .values({
        provider,
        externalEventId: webhook.externalEventId,
        eventType: webhook.eventType,
        payload: webhook.payload,
        status: "RECEIVED",
        correlationId,
      })
      .onConflictDoNothing({ target: [externalEvents.provider, externalEvents.externalEventId] })
      .returning({ id: externalEvents.id });
    // On conflict the row is committed by now (a concurrent insert of the same key waits for it),
    // so this read sees it.
    const [existing] = inserted
      ? [inserted]
      : await tx
          .select({ id: externalEvents.id })
          .from(externalEvents)
          .where(and(eq(externalEvents.provider, provider), eq(externalEvents.externalEventId, webhook.externalEventId)));
    const duplicate = !inserted;
    // Only event_deliveries_one_poll_key can conflict: a poll re-reading an event it already recorded.
    const delivered = await tx
      .insert(eventDeliveries)
      .values({ externalEventId: existing.id, isDuplicate: duplicate, source, correlationId })
      .onConflictDoNothing()
      .returning({ id: eventDeliveries.id });
    return { eventId: existing.id, duplicate, deliveryRecorded: delivered.length > 0 };
  });
}
