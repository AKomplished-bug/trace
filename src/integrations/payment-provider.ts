/**
 * What the application needs from a payment provider. Adapters in `integrations/<provider>`
 * implement it; services depend on this interface, never on a provider SDK, and `domain` doesn't
 * see it at all.
 */

/** A webhook whose signature checked out, reduced to what ingestion stores. */
export interface VerifiedWebhook {
  externalEventId: string;
  eventType: string;
  payload: unknown;
}

export interface WebhookVerifier {
  /** Throws `WebhookVerificationError` unless `rawBody` is signed by the provider. */
  verifyWebhook(rawBody: string, headers: Headers): VerifiedWebhook;
}

/** The signature is missing, malformed, stale or wrong. Deliberately carries no detail. */
export class WebhookVerificationError extends Error {
  constructor() {
    super("webhook signature verification failed");
    this.name = "WebhookVerificationError";
  }
}

/**
 * Provider-neutral view of a payment. `SUCCEEDED` and `FAILED` are final for our flow;
 * `PENDING` is anything still in progress.
 */
export interface ProviderPayment {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  /** Requested amount, integer cents. */
  amountCents: number;
  /** Amount actually collected, integer cents (0 until it succeeds). */
  amountReceivedCents: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** The provider element that moved the money (e.g. the charge), if any. */
  chargeId: string | null;
  /** Provider request id of the call that returned this, for logs. */
  requestId: string | null;
}

export interface CreateFundingPaymentInput {
  amountCents: number;
  /** Sent to the provider so retries of the same funding never create a second payment. */
  idempotencyKey: string;
  metadata: Record<string, string>;
}

/** A provider call failed or timed out; the outcome at the provider may be unknown. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export interface PaymentProvider extends WebhookVerifier {
  /** Creates and confirms a payment. A decline returns a `FAILED` payment; other failures throw `PaymentProviderError`. */
  createFundingPayment(input: CreateFundingPaymentInput): Promise<ProviderPayment>;
  /** Throws `PaymentProviderError` on failure. */
  retrievePaymentIntent(id: string): Promise<ProviderPayment>;
}
