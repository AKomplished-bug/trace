import type { PaymentProvider, ProviderPayment } from "../integrations/payment-provider";
import { paymentIntentIdFromEvent, STRIPE_FUNDING_EVENTS, StripeAdapter } from "../integrations/stripe";
import { config } from "../lib/config";
import { applyFundingOutcome } from "../services/funding";
import type { EventHandler } from "./handlers";

/**
 * Handlers for Stripe funding events, keyed by Stripe event type. Thin trust: `fetch` re-reads
 * the PaymentIntent from Stripe and `apply` acts on that, never on the webhook payload alone.
 */
export function stripeHandlers(provider: () => PaymentProvider): Record<string, EventHandler<ProviderPayment>> {
  return Object.fromEntries(
    Object.entries(STRIPE_FUNDING_EVENTS).map(([eventType, fundingEvent]) => {
      const handler: EventHandler<ProviderPayment> = {
        async fetch(event, log) {
          const payment = await provider().retrievePaymentIntent(paymentIntentIdFromEvent(event.payload));
          log.info(
            { outcome: "fetched", provider_object_id: payment.id, provider_status: payment.status, provider_request_id: payment.requestId },
            "fetched PaymentIntent",
          );
          return payment;
        },
        apply(tx, event, payment, log) {
          return applyFundingOutcome(tx, fundingEvent, { eventId: event.id, provider: event.provider, payment }, log);
        },
      };
      return [eventType, handler];
    }),
  );
}

let configured: StripeAdapter | undefined;

/** The worker's Stripe adapter from env, created on first use. */
export function configuredStripe(): StripeAdapter {
  configured ??= new StripeAdapter({ secretKey: config().STRIPE_SECRET_KEY, webhookSecret: config().STRIPE_WEBHOOK_SECRET });
  return configured;
}
