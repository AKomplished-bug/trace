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
  /** What we attached when creating it; null when absent (the payment wasn't created by us). */
  metadata: { transactionId: string | null };
  /** Provider request id of the call that returned this, for logs. */
  requestId: string | null;
}

/** A created-at window for list reads: [start, end). */
export interface ListWindow {
  start: Date;
  end: Date;
}

/** Every item of a paginated list read, and the provider request id of each page (for logs). */
export interface ListResult<T> {
  items: T[];
  requestIds: Array<string | null>;
}

/** List reads stop with an error past this many pages (of 100) instead of loading an unbounded window. */
export const MAX_LIST_PAGES = 50;

/** A payment from a list read, with when the provider created it. */
export type ListedPayment = ProviderPayment & { createdAt: Date };

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

/** The provider answered and refused the request (e.g. an invalid operation); retrying the same request won't help. */
export class ProviderRejectedError extends PaymentProviderError {
  constructor(
    message: string,
    requestId: string | null,
    /** The HTTP status Increase answered with; null when we refused before calling. */
    readonly status: number | null = null,
  ) {
    super(message, requestId);
    this.name = "ProviderRejectedError";
  }
}

/**
 * The idempotency key was already used for a request with different arguments. An object exists
 * for that key (`resourceId`), so the outcome must not be treated as "nothing was created".
 */
export class IdempotencyKeyReusedError extends ProviderRejectedError {
  constructor(
    message: string,
    requestId: string | null,
    readonly resourceId: string | null,
  ) {
    super(message, requestId, 409);
    this.name = "IdempotencyKeyReusedError";
  }
}

export interface PaymentProvider extends WebhookVerifier {
  /** Our provider name, as stored in `transactions.provider` and `external_events.provider`. */
  readonly name: string;
  /** Creates and confirms a payment. A decline returns a `FAILED` payment; other failures throw `PaymentProviderError`. */
  createFundingPayment(input: CreateFundingPaymentInput): Promise<ProviderPayment>;
  /** Throws `PaymentProviderError` on failure. */
  retrievePaymentIntent(id: string): Promise<ProviderPayment>;
  /**
   * Every payment created in `window`, for reconciliation. Stops between pages once `signal`
   * aborts; throws `PaymentProviderError` on failure or past `MAX_LIST_PAGES`.
   */
  listPayments(window: ListWindow, signal?: AbortSignal): Promise<ListResult<ListedPayment>>;
}
