import type { Db } from "../../../db/client";
import { isWebhookVerificationError, type WebhookVerifier } from "../../../integrations/payment-provider";
import { safeErrorForLog } from "../../../lib/errors";
import { newId } from "../../../lib/ids";
import type { Logger } from "../../../lib/logger";
import { ingestEvent } from "../../../services/ingestion";
import { countOutcome } from "../../../services/metrics";
import { errorResponse } from "../responses";

export interface WebhookDeps {
  db: Db;
  webhookVerifiers: Readonly<Record<string, WebhookVerifier>>;
  logger: Logger;
}

/**
 * POST /api/webhooks/:provider — verify the signature, store the raw event (deduplicated by the
 * provider's event id), record the delivery, return 200. No other work: the worker processes it.
 * A failure to store returns 500 so the provider redelivers.
 */
export async function handleWebhook(deps: WebhookDeps, provider: string, request: Request): Promise<Response> {
  const correlationId = newId();
  const log = deps.logger.child({ correlation_id: correlationId, provider });
  const verifier = Object.hasOwn(deps.webhookVerifiers, provider) ? deps.webhookVerifiers[provider] : undefined;
  if (!verifier) {
    // Not the path segment as a label: anyone can send any value.
    countOutcome("webhooks_received_total", { provider: "unknown", outcome: "unknown_provider" });
    log.warn({ outcome: "unknown_provider" }, "webhook for unknown provider");
    return errorResponse(404, "not_found", "Unknown webhook provider");
  }

  try {
    const rawBody = await request.text();
    let webhook;
    try {
      webhook = verifier.verifyWebhook(rawBody, request.headers);
    } catch (error) {
      if (!isWebhookVerificationError(error)) throw error;
      countOutcome("webhooks_received_total", { provider, outcome: "invalid_signature" });
      log.warn({ outcome: "invalid_signature" }, "webhook rejected: signature verification failed");
      return errorResponse(400, "invalid_signature", "Webhook signature verification failed");
    }
    const { eventId, duplicate } = await ingestEvent(deps.db, provider, webhook, correlationId);
    const outcome = duplicate ? "duplicate" : "received";
    countOutcome("webhooks_received_total", { provider, outcome });
    log.info(
      { outcome, event_id: eventId, external_event_id: webhook.externalEventId, event_type: webhook.eventType },
      duplicate ? "duplicate webhook delivery recorded; no effect" : "webhook event stored",
    );
    return Response.json({ received: true });
  } catch (error) {
    countOutcome("webhooks_received_total", { provider, outcome: "error" });
    log.error({ outcome: "error", err: safeErrorForLog(error) }, "webhook ingestion failed");
    return errorResponse(500, "internal_error", "Webhook could not be stored; it will be redelivered");
  }
}
