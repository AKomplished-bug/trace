import type { CardProvider, ProviderCardPayment } from "../integrations/card-provider";
import { achTransferIdFromEvent, cardPaymentIdFromEvent, INCREASE_ACH_TRANSFER_EVENTS, INCREASE_CARD_PAYMENT_EVENTS, IncreaseAdapter } from "../integrations/increase";
import type { ProviderTransfer, TransferProvider } from "../integrations/transfer-provider";
import { config } from "../lib/config";
import { applyCardPayment } from "../services/cards";
import { applyAchTransfer } from "../services/payments";
import type { EventHandler } from "./handlers";

/**
 * Handlers for Increase card payment events, keyed by event category. Increase webhooks are
 * thin, so `fetch` re-reads the whole card payment and `apply` applies the steps we haven't
 * applied yet; created and updated are handled the same way.
 */
export function increaseHandlers(provider: () => CardProvider): Record<string, EventHandler<ProviderCardPayment>> {
  const handler: EventHandler<ProviderCardPayment> = {
    async fetch(event, log) {
      const cardPayment = await provider().retrieveCardPayment(cardPaymentIdFromEvent(event.payload));
      log.info(
        { outcome: "fetched", provider_object_id: cardPayment.id, steps: cardPayment.elements.length, provider_request_id: cardPayment.requestId },
        "fetched card payment",
      );
      return cardPayment;
    },
    apply(tx, event, cardPayment, log) {
      return applyCardPayment(tx, { eventId: event.id, provider: event.provider, cardPayment }, log);
    },
  };
  return Object.fromEntries(INCREASE_CARD_PAYMENT_EVENTS.map((category) => [category, handler]));
}

/**
 * Handlers for Increase ACH transfer events (outbound payments). Thin webhooks: `fetch` re-reads
 * the transfer and `apply` applies whatever steps it shows that we haven't applied yet.
 */
export function increaseTransferHandlers(provider: () => TransferProvider): Record<string, EventHandler<ProviderTransfer>> {
  const handler: EventHandler<ProviderTransfer> = {
    async fetch(event, log) {
      const transfer = await provider().retrieveTransfer(achTransferIdFromEvent(event.payload));
      log.info(
        { outcome: "fetched", provider_object_id: transfer.id, provider_status: transfer.status, provider_request_id: transfer.requestId },
        "fetched ACH transfer",
      );
      return transfer;
    },
    apply(tx, event, transfer, log) {
      return applyAchTransfer(tx, { eventId: event.id, provider: event.provider, transfer }, log);
    },
  };
  return Object.fromEntries(INCREASE_ACH_TRANSFER_EVENTS.map((category) => [category, handler]));
}

let configured: IncreaseAdapter | undefined;

/** The worker's Increase adapter from env, created on first use. */
export function configuredIncrease(): IncreaseAdapter {
  configured ??= new IncreaseAdapter({ apiKey: config().INCREASE_API_KEY, webhookSecret: config().INCREASE_WEBHOOK_SECRET });
  return configured;
}
