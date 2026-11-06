import type { TransferSnapshot } from "../domain/payments";
import type { WebhookVerifier } from "./payment-provider";

/**
 * What the application needs from a bank-transfer provider for outbound payments. Adapters in
 * `integrations/<provider>` implement it; services never import an SDK. Failures throw
 * `PaymentProviderError` (timeouts, 5xx, rate limits: the outcome may be unknown),
 * `ProviderRejectedError` (the provider refused the request) or `IdempotencyKeyReusedError`.
 */

/** One outbound transfer as the provider has it now. Never carries the recipient's account number. */
export interface ProviderTransfer {
  id: string;
  amountCents: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** The provider's own status, for logs only; decisions use `snapshot`. */
  status: string;
  /** The idempotency key we created it with, if any (how a transfer finds its payment before we stored its id). */
  idempotencyKey: string | null;
  snapshot: TransferSnapshot;
  /** Provider request id of the call that returned this, for logs. */
  requestId: string | null;
}

export interface CreateTransferInput {
  /** The provider account the money leaves from (`accounts.provider_id`). */
  sourceAccountId: string;
  amountCents: number;
  accountNumber: string;
  routingNumber: string;
  recipientName: string;
  statementDescriptor: string;
  /** Sent to the provider so retries and crashes never create a second transfer. */
  idempotencyKey: string;
}

export interface TransferProvider extends WebhookVerifier {
  /** Our provider name, as stored in `transactions.provider` and `payments.provider`. */
  readonly name: string;
  createTransfer(input: CreateTransferInput): Promise<ProviderTransfer>;
  retrieveTransfer(id: string): Promise<ProviderTransfer>;
  /** Sandbox only: the network steps. Effects arrive by webhook. */
  simulateTransferSubmission(id: string): Promise<ProviderTransfer>;
  simulateTransferSettlement(id: string): Promise<ProviderTransfer>;
  simulateTransferReturn(id: string, reason?: string): Promise<ProviderTransfer>;
}
