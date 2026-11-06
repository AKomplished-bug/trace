import type { CardPaymentElement } from "../domain/cards";
import type { WebhookVerifier } from "./payment-provider";

/**
 * What the application needs from a card issuer. Adapters in `integrations/<provider>`
 * implement it and map provider payloads onto these types; services never import an SDK.
 * Failures throw `PaymentProviderError` (or `ProviderRejectedError` when the provider refused
 * the request).
 */

/** One card payment (authorization and everything that followed it), as the provider has it now. */
export interface ProviderCardPayment {
  id: string;
  /** The provider's card id, as stored in `cards.provider_id`. */
  cardId: string;
  /** Lifecycle steps in the order they happened. */
  elements: CardPaymentElement[];
  /** Provider request id of the call that returned this, for logs. */
  requestId: string | null;
}

export interface SimulateAuthorizationInput {
  /** The provider's card id. */
  cardId: string;
  amountCents: number;
  merchant?: string;
}

export interface SimulationResult {
  /** The card payment the simulation created or changed. */
  cardPaymentId: string;
  /** The provider declined the authorization (no hold will follow). */
  declined: boolean;
  requestId: string | null;
}

export interface CardProvider extends WebhookVerifier {
  /** Our provider name, as stored in `transactions.provider` and `external_events.provider`. */
  readonly name: string;
  retrieveCardPayment(id: string): Promise<ProviderCardPayment>;
  /** Sandbox only: the steps a merchant and the network would take. Effects arrive by webhook. */
  simulateAuthorization(input: SimulateAuthorizationInput): Promise<SimulationResult>;
  /** Settles the payment's authorization for `amountCents` (may differ from the authorized amount). */
  simulateSettlement(input: { cardPaymentId: string; amountCents: number }): Promise<SimulationResult>;
  /** Undoes the purchase: voids the authorization if unsettled, else refunds (all or `amountCents`). */
  simulateReversal(input: { cardPaymentId: string; amountCents?: number }): Promise<SimulationResult>;
  simulateExpiration(input: { cardPaymentId: string }): Promise<SimulationResult>;
}
