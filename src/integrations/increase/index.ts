import { createHmac, timingSafeEqual } from "node:crypto";
import Increase, { APIError } from "increase";
import { z } from "zod";
import type { CardPaymentElement } from "../../domain/cards";
import type { CardProvider, ProviderCardPayment, SimulateAuthorizationInput, SimulationResult } from "../card-provider";
import { PaymentProviderError, ProviderRejectedError, WebhookVerificationError, type VerifiedWebhook } from "../payment-provider";

export const INCREASE_PROVIDER = "increase";
/** Every Increase call has this deadline unless overridden; the SDK default is 60 s. */
export const INCREASE_TIMEOUT_MS = 10_000;
/** Standard Webhooks replay window: reject a `webhook-timestamp` further than this from now. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** Event categories that carry card lifecycle changes; the worker re-fetches the card payment. */
export const INCREASE_CARD_PAYMENT_EVENTS = ["card_payment.created", "card_payment.updated"] as const;

/**
 * Increase event categories a card flow (and the sandbox bootstrap) emits that we deliberately
 * don't act on: the card_payment events carry the lifecycle. These become IGNORED; any other
 * category without a handler is retried and surfaces to Ops.
 * https://increase.com/documentation/api/events
 */
export const INCREASE_IGNORED_EVENT_TYPES = [
  "pending_transaction.created",
  "pending_transaction.updated",
  "transaction.created",
  "declined_transaction.created",
  "card.created",
  "card.updated",
  "account.created",
  "account.updated",
  "account_number.created",
  "account_number.updated",
  "inbound_ach_transfer.created",
  "inbound_ach_transfer.updated",
  "event_subscription.created",
  "event_subscription.updated",
  // Increase's endpoint health check.
  "group.heartbeat",
] as const;

export interface IncreaseAdapterOptions {
  apiKey: string;
  webhookSecret: string;
  /** Tests pass the fake's fetch; never call real Increase from tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const eventSchema = z.object({ id: z.string().min(1), category: z.string().min(1) });
const cardPaymentEventSchema = z.object({
  associated_object_type: z.literal("card_payment"),
  associated_object_id: z.string().startsWith("card_payment_"),
});

/** The card payment id a stored `card_payment.*` event points at (thin webhook: re-fetch it). */
export function cardPaymentIdFromEvent(payload: unknown): string {
  return cardPaymentEventSchema.parse(payload).associated_object_id;
}

/**
 * Standard Webhooks verification as Increase documents it
 * (https://increase.com/documentation/webhooks#securing-your-webhook-endpoint-recommended):
 * HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${body}`, keyed with the subscription's
 * shared secret as given (the SDK's own `unwrap` does the same), base64, `v1,` prefix; several
 * space-separated signatures during rotation. Constant-time compare; stale timestamps rejected.
 */
export function verifyStandardWebhook(rawBody: string, headers: Headers, secret: string, nowSeconds = Date.now() / 1000): void {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) throw new WebhookVerificationError();
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) throw new WebhookVerificationError();
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const signature of signatures.split(" ")) {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return;
  }
  throw new WebhookVerificationError();
}

type Element = Increase.CardPayment.Element;

function positiveCents(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0;
}

/**
 * Maps one card payment element onto the provider-neutral step. Element categories and fields:
 * https://increase.com/documentation/api/card-payments. Per the lifecycle guide
 * (https://increase.com/documentation/card-payment-lifecycle) a card_reversal cancels (part of)
 * an authorization and only changes the pending transaction; money back after settlement is a
 * card_refund, which may arrive on its own card payment with no link to the purchase.
 */
export function toCardPaymentElement(element: Element): CardPaymentElement {
  const { category } = element;
  const unsupported = (id: string, reason: string): CardPaymentElement => ({ kind: "UNSUPPORTED", id, category, reason });
  const usd = (currency: string) => currency === "USD";
  switch (category) {
    case "card_authorization": {
      const a = required(element.card_authorization, category);
      if (a.direction !== "settlement") return unsupported(a.id, "refund authorizations are not modelled");
      if (!usd(a.currency) || !positiveCents(a.amount)) return unsupported(a.id, `authorization of ${a.amount} ${a.currency}`);
      return { kind: "AUTHORIZATION", id: a.id, amountCents: a.amount, merchant: a.merchant_descriptor || null, expiresAt: new Date(a.expires_at) };
    }
    case "card_settlement": {
      const s = required(element.card_settlement, category);
      if (!usd(s.currency) || !positiveCents(s.amount)) return unsupported(s.id, `settlement of ${s.amount} ${s.currency}`);
      return { kind: "SETTLEMENT", id: s.id, amountCents: s.amount };
    }
    case "card_reversal": {
      const r = required(element.card_reversal, category);
      if (!usd(r.currency) || !positiveCents(r.reversal_amount)) return unsupported(r.id, `reversal of ${r.reversal_amount} ${r.currency}`);
      return { kind: "REVERSAL", id: r.id, amountCents: r.reversal_amount, remainingAuthorizationCents: r.updated_authorization_amount };
    }
    case "card_authorization_expiration": {
      const e = required(element.card_authorization_expiration, category);
      return { kind: "EXPIRATION", id: e.id, amountCents: e.expired_amount };
    }
    case "card_refund": {
      const r = required(element.card_refund, category);
      if (!usd(r.currency) || !positiveCents(r.amount)) return unsupported(r.id, `refund of ${r.amount} ${r.currency}`);
      return { kind: "REFUND", id: r.id, amountCents: r.amount, merchant: r.merchant_name || null };
    }
    // No hold and no money: a declined attempt, a 3DS check, a card check, a balance inquiry.
    case "card_decline":
    case "card_authentication":
    case "card_validation":
    case "card_balance_inquiry":
      return { kind: "NO_EFFECT", id: elementId(element), category };
    default:
      // card_increment, card_fuel_confirmation, card_financial, other: change holds or money in ways we don't model.
      return unsupported(elementId(element), `${category} elements are not modelled`);
  }
}

function required<T>(detail: T | null | undefined, category: string): T {
  if (!detail) throw new Error(`Increase ${category} element without its ${category} object`);
  return detail;
}

function elementId(element: Element): string {
  const detail = (element as unknown as Record<string, { id?: unknown } | null | undefined>)[element.category];
  return typeof detail?.id === "string" ? detail.id : `${element.category}@${element.created_at}`;
}

/** Maps a card payment onto the provider-neutral type, elements in Increase's (chronological) order. */
export function toProviderCardPayment(payment: Increase.CardPayment, requestId: string | null): ProviderCardPayment {
  return { id: payment.id, cardId: payment.card_id, elements: payment.elements.map(toCardPaymentElement), requestId };
}

/**
 * Increase sandbox through the `CardProvider` interface. Always the sandbox environment, so a
 * production key fails instead of moving real money. Retries are ours, so the SDK never retries.
 * Sandbox rate limit is 20 requests/s; our calls are one or two per user action or event.
 */
export class IncreaseAdapter implements CardProvider {
  readonly name = INCREASE_PROVIDER;
  private client: Increase | undefined;

  constructor(private readonly options: IncreaseAdapterOptions) {}

  verifyWebhook(rawBody: string, headers: Headers): VerifiedWebhook {
    verifyStandardWebhook(rawBody, headers, this.options.webhookSecret);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError();
    }
    const event = eventSchema.safeParse(payload);
    if (!event.success) throw new WebhookVerificationError();
    return { externalEventId: event.data.id, eventType: event.data.category, payload };
  }

  async retrieveCardPayment(id: string): Promise<ProviderCardPayment> {
    const { payment, requestId } = await this.fetchCardPayment(id);
    return toProviderCardPayment(payment, requestId);
  }

  // https://increase.com/documentation/api/card-payments#sandbox-create-a-card-authorization
  async simulateAuthorization(input: SimulateAuthorizationInput): Promise<SimulationResult> {
    const { data, requestId } = await this.call("simulate card authorization", () =>
      this.increase().simulations.cardAuthorizations.create({
        card_id: input.cardId,
        amount: input.amountCents,
        ...(input.merchant ? { merchant_descriptor: input.merchant } : {}),
      }),
    );
    const cardPaymentId =
      data.pending_transaction?.source.card_authorization?.card_payment_id ?? data.declined_transaction?.source.card_decline?.card_payment_id;
    if (!cardPaymentId) throw new PaymentProviderError("Increase authorization simulation returned no card payment", requestId);
    return { cardPaymentId, declined: data.pending_transaction === null, requestId };
  }

  // https://increase.com/documentation/api/card-payments#sandbox-settle-a-card-authorization
  async simulateSettlement(input: { cardPaymentId: string; amountCents: number }): Promise<SimulationResult> {
    const { payment } = await this.fetchCardPayment(input.cardPaymentId);
    const pendingTransactionId = payment.elements.find((e) => e.card_authorization)?.card_authorization?.pending_transaction_id;
    if (!pendingTransactionId) throw new ProviderRejectedError(`card payment ${payment.id} has no authorization to settle`, null);
    const { requestId } = await this.call("simulate card settlement", () =>
      this.increase().simulations.cardSettlements.create({
        card_id: payment.card_id,
        pending_transaction_id: pendingTransactionId,
        amount: input.amountCents,
      }),
    );
    return { cardPaymentId: payment.id, declined: false, requestId };
  }

  /**
   * Before settlement a card_reversal voids the authorization
   * (https://increase.com/documentation/api/card-payments#sandbox-reverse-a-card-authorization);
   * after it, a card_refund against the latest settlement's transaction
   * (https://increase.com/documentation/api/card-payments#sandbox-refund-a-card-transaction).
   */
  async simulateReversal(input: { cardPaymentId: string; amountCents?: number }): Promise<SimulationResult> {
    const { payment } = await this.fetchCardPayment(input.cardPaymentId);
    const amount = input.amountCents === undefined ? {} : { amount: input.amountCents };
    const settlement = payment.elements.findLast((e) => e.card_settlement)?.card_settlement;
    const { requestId } = settlement
      ? await this.call("simulate card refund", () =>
          this.increase().simulations.cardRefunds.create({ transaction_id: settlement.transaction_id, ...amount }),
        )
      : await this.call("simulate card reversal", () =>
          this.increase().simulations.cardReversals.create({ card_payment_id: payment.id, ...amount }),
        );
    return { cardPaymentId: payment.id, declined: false, requestId };
  }

  // https://increase.com/documentation/api/card-payments#sandbox-expire-a-card-authorization
  async simulateExpiration(input: { cardPaymentId: string }): Promise<SimulationResult> {
    const { requestId } = await this.call("simulate card authorization expiration", () =>
      this.increase().simulations.cardAuthorizationExpirations.create({ card_payment_id: input.cardPaymentId }),
    );
    return { cardPaymentId: input.cardPaymentId, declined: false, requestId };
  }

  private async fetchCardPayment(id: string): Promise<{ payment: Increase.CardPayment; requestId: string | null }> {
    const { data, requestId } = await this.call(`retrieve card payment ${id}`, () => this.increase().cardPayments.retrieve(id));
    return { payment: data, requestId };
  }

  /** Runs one SDK call, returning its data and request id, or throwing a provider error without Increase's body text. */
  private async call<T>(action: string, run: () => { withResponse(): Promise<{ data: T; response: Response }> }) {
    try {
      const { data, response } = await run().withResponse();
      return { data, requestId: response.headers.get("x-request-id") };
    } catch (error) {
      throw providerError(action, error);
    }
  }

  private increase(): Increase {
    this.client ??= new Increase({
      apiKey: this.options.apiKey,
      environment: "sandbox",
      baseURL: null,
      timeout: this.options.timeoutMs ?? INCREASE_TIMEOUT_MS,
      maxRetries: 0,
      fetch: this.options.fetch,
    });
    return this.client;
  }
}

function providerError(action: string, error: unknown): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;
  if (error instanceof APIError && error.status !== undefined) {
    const requestId = error.headers?.get("x-request-id") ?? null;
    const body = error.error as { type?: unknown } | undefined;
    const type = typeof body?.type === "string" ? body.type : `HTTP ${error.status}`;
    const message = `Increase ${action} failed: ${type}`;
    // A 4xx other than rate limiting means Increase refused this request; retrying won't help.
    return error.status >= 400 && error.status < 500 && error.status !== 429
      ? new ProviderRejectedError(message, requestId)
      : new PaymentProviderError(message, requestId);
  }
  const name = error instanceof Error ? error.name : "unknown error";
  return new PaymentProviderError(`Increase ${action} failed: ${name}`, null);
}
