import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { payments } from "../db/schema";
import type { ProviderTransfer, TransferProvider } from "../integrations/transfer-provider";
import { safeErrorForLog } from "../lib/errors";
import type { Logger } from "../lib/logger";

/** A sandbox network step the owner asks the provider to simulate on a payment's transfer. */
export type PaymentSimulation = { action: "submit" } | { action: "settle" } | { action: "return"; reason?: string };

/** No payment with that id on this account. */
export class PaymentSimulationNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`payment ${paymentId} not found`);
    this.name = "PaymentSimulationNotFoundError";
  }
}

/** The submitter hasn't handed the payment to the provider yet, so there is no transfer to drive. */
export class PaymentNotSubmittedError extends Error {
  constructor(paymentId: string) {
    super(`payment ${paymentId} has no provider transfer yet`);
    this.name = "PaymentNotSubmittedError";
  }
}

/**
 * Asks the provider's sandbox to simulate one network step on the payment's transfer. Reads only —
 * nothing here changes our state, and no transaction is open during the provider call: the effect
 * arrives as an `ach_transfer.updated` webhook and the worker applies it. Provider failures
 * propagate (`PaymentProviderError`, or `ProviderRejectedError` when the provider refused the step
 * for the transfer's current state).
 */
export async function simulatePaymentStep(
  db: Db,
  provider: TransferProvider,
  input: { accountId: string; paymentId: string; simulation: PaymentSimulation },
  logger: Logger,
): Promise<ProviderTransfer> {
  const { simulation } = input;
  const log = logger.child({ account_id: input.accountId, payment_id: input.paymentId, simulation: simulation.action });
  const [payment] = await db
    .select({ transactionId: payments.transactionId, providerObjectId: payments.providerObjectId })
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.accountId, input.accountId), eq(payments.provider, provider.name)));
  if (!payment) throw new PaymentSimulationNotFoundError(input.paymentId);
  const txLog = log.child({ transaction_id: payment.transactionId, provider_object_id: payment.providerObjectId });
  if (!payment.providerObjectId) {
    txLog.info({ outcome: "refused", reason: "not_submitted" }, "payment simulation refused; nothing sent to the provider");
    throw new PaymentNotSubmittedError(input.paymentId);
  }

  let transfer: ProviderTransfer;
  try {
    if (simulation.action === "submit") transfer = await provider.simulateTransferSubmission(payment.providerObjectId);
    else if (simulation.action === "settle") transfer = await provider.simulateTransferSettlement(payment.providerObjectId);
    else transfer = await provider.simulateTransferReturn(payment.providerObjectId, simulation.reason);
  } catch (error) {
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    txLog.error({ outcome: "provider_error", err: safeErrorForLog(error), provider_request_id: requestId }, "payment simulation failed at the provider; nothing changed");
    throw error;
  }
  txLog.info(
    { outcome: "requested", provider_status: transfer.status, provider_request_id: transfer.requestId },
    "payment simulation requested; its effect arrives by webhook",
  );
  return transfer;
}
