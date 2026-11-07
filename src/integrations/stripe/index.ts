import Stripe from "stripe";
import { z } from "zod";
import type { FundingEvent } from "../../domain/funding";
import {
  MAX_LIST_PAGES,
  PaymentProviderError,
  WebhookVerificationError,
  type CreateFundingPaymentInput,
  type ListedPayment,
  type ListResult,
  type ListWindow,
  type PaymentProvider,
  type ProviderPayment,
  type VerifiedWebhook,
} from "../payment-provider";

export const STRIPE_PROVIDER = "stripe";
/** Every Stripe call has this deadline unless overridden. */
export const STRIPE_TIMEOUT_MS = 10_000;
/** Stripe's test PaymentMethod for a Visa that always succeeds. */
export const TEST_PAYMENT_METHOD = "pm_card_visa";

/**
 * Stripe event types we receive (our own PaymentIntents emit them, and `stripe listen` forwards
 * them) but deliberately don't act on: the PaymentIntent events carry the outcome. These become
 * IGNORED; any other type without a handler is retried and surfaces to Ops.
 */
export const STRIPE_IGNORED_EVENT_TYPES = [
  "payment_intent.created",
  "charge.succeeded",
  "charge.failed",
  "charge.updated",
] as const;

/** Stripe event types that carry a funding outcome, and the internal event each maps to. */
export const STRIPE_FUNDING_EVENTS: Readonly<Record<string, FundingEvent>> = {
  "payment_intent.succeeded": "FUNDING_CONFIRMED",
  "payment_intent.payment_failed": "FUNDING_FAILED",
};

export interface StripeAdapterOptions {
  secretKey: string;
  webhookSecret: string;
  /** Tests pass `Stripe.createFetchHttpClient(fake)`; never call real Stripe from tests. */
  httpClient?: Stripe.HttpClient;
  timeoutMs?: number;
}

const eventSchema = z.object({ id: z.string().min(1), type: z.string().min(1) });
const paymentIntentEventSchema = z.object({ data: z.object({ object: z.object({ id: z.string().startsWith("pi_") }) }) });

/** The PaymentIntent id a stored `payment_intent.*` event points at. */
export function paymentIntentIdFromEvent(payload: unknown): string {
  return paymentIntentEventSchema.parse(payload).data.object.id;
}

/** Maps a PaymentIntent onto the provider-neutral payment. */
export function toProviderPayment(intent: Stripe.PaymentIntent, requestId: string | null): ProviderPayment {
  let status: ProviderPayment["status"] = "PENDING";
  if (intent.status === "succeeded") status = "SUCCEEDED";
  // A failed confirmation returns the intent to requires_payment_method with the error attached.
  else if (intent.status === "canceled" || (intent.status === "requires_payment_method" && intent.last_payment_error)) {
    status = "FAILED";
  }
  const charge = intent.latest_charge;
  return {
    id: intent.id,
    status,
    amountCents: intent.amount,
    amountReceivedCents: intent.amount_received,
    currency: intent.currency.toUpperCase(),
    chargeId: typeof charge === "string" ? charge : (charge?.id ?? null),
    metadata: { transactionId: intent.metadata?.transaction_id ?? null },
    requestId,
  };
}

/** Stripe through the `PaymentProvider` interface. Retries are ours, so the SDK never retries. */
export class StripeAdapter implements PaymentProvider {
  readonly name = STRIPE_PROVIDER;
  private client: Stripe | undefined;

  constructor(private readonly options: StripeAdapterOptions) {}

  verifyWebhook(rawBody: string, headers: Headers): VerifiedWebhook {
    const signature = headers.get("stripe-signature");
    if (!signature) throw new WebhookVerificationError();
    try {
      Stripe.webhooks.constructEvent(rawBody, signature, this.options.webhookSecret);
    } catch {
      throw new WebhookVerificationError();
    }
    const payload: unknown = JSON.parse(rawBody);
    const event = eventSchema.safeParse(payload);
    if (!event.success) throw new WebhookVerificationError();
    return { externalEventId: event.data.id, eventType: event.data.type, payload };
  }

  async createFundingPayment(input: CreateFundingPaymentInput): Promise<ProviderPayment> {
    try {
      const intent = await this.stripe().paymentIntents.create(
        {
          amount: input.amountCents,
          currency: "usd",
          payment_method: TEST_PAYMENT_METHOD,
          // Confirmed server-side with no return_url, so redirect-based methods are excluded.
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          confirm: true,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toProviderPayment(intent, intent.lastResponse.requestId ?? null);
    } catch (error) {
      // A decline still created the PaymentIntent; its payment_failed webhook settles our side.
      if (error instanceof Stripe.errors.StripeCardError && error.payment_intent) {
        return toProviderPayment(error.payment_intent, error.requestId ?? null);
      }
      throw providerError("create PaymentIntent", error);
    }
  }

  async retrievePaymentIntent(id: string): Promise<ProviderPayment> {
    try {
      const intent = await this.stripe().paymentIntents.retrieve(id);
      return toProviderPayment(intent, intent.lastResponse.requestId ?? null);
    } catch (error) {
      throw providerError(`retrieve PaymentIntent ${id}`, error);
    }
  }

  /**
   * https://docs.stripe.com/api/payment_intents/list: newest first, `created[gte]` / `created[lt]`
   * in Unix seconds (so the window is widened to whole seconds), up to 100 per page, next page via
   * `starting_after` = the last id while `has_more`. Each page has the SDK timeout. Exercised only
   * through the SDK and the fake, not against live Stripe.
   */
  async listPayments(window: ListWindow, signal?: AbortSignal): Promise<ListResult<ListedPayment>> {
    const result: ListResult<ListedPayment> = { items: [], requestIds: [] };
    const created = { gte: Math.floor(window.start.getTime() / 1000), lt: Math.ceil(window.end.getTime() / 1000) };
    let startingAfter: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_LIST_PAGES) throw new PaymentProviderError(`Stripe list PaymentIntents stopped: more than ${MAX_LIST_PAGES} pages`, null);
      if (signal?.aborted) throw new PaymentProviderError("Stripe list PaymentIntents stopped: deadline passed", null);
      let list: Stripe.Response<Stripe.ApiList<Stripe.PaymentIntent>>;
      try {
        list = await this.stripe().paymentIntents.list({ created, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      } catch (error) {
        throw providerError("list PaymentIntents", error);
      }
      const requestId = list.lastResponse.requestId ?? null;
      result.requestIds.push(requestId);
      for (const intent of list.data) result.items.push({ ...toProviderPayment(intent, requestId), createdAt: new Date(intent.created * 1000) });
      const last = list.data.at(-1);
      if (!list.has_more || !last) return result;
      startingAfter = last.id;
    }
  }

  private stripe(): Stripe {
    this.client ??= new Stripe(this.options.secretKey, {
      timeout: this.options.timeoutMs ?? STRIPE_TIMEOUT_MS,
      maxNetworkRetries: 0,
      httpClient: this.options.httpClient,
    });
    return this.client;
  }
}

function providerError(action: string, error: unknown): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;
  if (error instanceof Stripe.errors.StripeError) {
    return new PaymentProviderError(`Stripe ${action} failed: ${error.type}${error.code ? ` (${error.code})` : ""}`, error.requestId ?? null);
  }
  return new PaymentProviderError(`Stripe ${action} failed`, null);
}
