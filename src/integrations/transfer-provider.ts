import type { TransferSnapshot } from "../domain/payments";
import type { ListResult, ListWindow, WebhookVerifier } from "./payment-provider";

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

/** A transfer as read for reconciliation: when the provider created it and its latest step. */
export type ListedTransfer = ProviderTransfer & { createdAt: Date; updatedAt: Date };

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
  retrieveTransfer(id: string): Promise<ListedTransfer>;
  /** The transfer created with our idempotency key, or null if the provider has none. */
  findTransferByIdempotencyKey(idempotencyKey: string): Promise<ProviderTransfer | null>;
  /** Every outbound transfer from provider account `filter.accountId` created in `window`, for reconciliation; stops between pages once `signal` aborts. */
  listTransfers(window: ListWindow, filter: { accountId: string }, signal?: AbortSignal): Promise<ListResult<ListedTransfer>>;
  /** Sandbox only: the network steps. Effects arrive by webhook. */
  simulateTransferSubmission(id: string): Promise<ProviderTransfer>;
  simulateTransferSettlement(id: string): Promise<ProviderTransfer>;
  simulateTransferReturn(id: string, reason?: string): Promise<ProviderTransfer>;
}
