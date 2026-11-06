import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { cards, transactions } from "../db/schema";
import type { CardProvider, SimulationResult } from "../integrations/card-provider";
import { safeErrorForLog } from "../lib/errors";
import type { Logger } from "../lib/logger";

/** A sandbox lifecycle step the owner asks the card provider to simulate. */
export type CardSimulation =
  | { action: "authorize"; amountCents: number; merchant?: string }
  | { action: "settle"; transactionId: string; amountCents: number }
  | { action: "reverse"; transactionId: string; amountCents?: number }
  | { action: "expire"; transactionId: string };

/** The card, or the card purchase, isn't on this account (or has no provider card payment). */
export class SimulationTargetNotFoundError extends Error {
  constructor(readonly target: "card" | "transaction") {
    super(`${target} not found`);
    this.name = "SimulationTargetNotFoundError";
  }
}

/** The card has no provider card yet (see `npm run increase:bootstrap`). */
export class CardNotLinkedError extends Error {
  constructor(cardId: string) {
    super(`card ${cardId} is not linked to a provider card`);
    this.name = "CardNotLinkedError";
  }
}

/** A partial reversal before settlement: the worker doesn't model a shrinking authorization, so it would fail to Ops. */
export class PartialReversalNotSupportedError extends Error {
  constructor(cardPaymentId: string) {
    super(`card payment ${cardPaymentId} is unsettled; only a full reversal is supported`);
    this.name = "PartialReversalNotSupportedError";
  }
}

/**
 * Asks the provider's sandbox to simulate one card lifecycle step. Reads only — nothing here
 * changes our state, and no transaction is open during the provider call: the effect arrives as
 * a webhook and the worker applies it like any real card event. Steps on a purchase first
 * re-fetch its card payment: it must be on this card, and an unsettled one may only be reversed
 * in full (a partial void would block the card payment at the worker). Provider failures propagate
 * (`PaymentProviderError`, or `ProviderRejectedError` when the provider refused the step).
 */
export async function simulateCardStep(
  db: Db,
  provider: CardProvider,
  input: { accountId: string; cardId: string; simulation: CardSimulation },
  logger: Logger,
): Promise<SimulationResult> {
  const { simulation } = input;
  const log = logger.child({ account_id: input.accountId, card_id: input.cardId, simulation: simulation.action });
  const [card] = await db
    .select({ providerId: cards.providerId })
    .from(cards)
    .where(and(eq(cards.id, input.cardId), eq(cards.accountId, input.accountId)));
  if (!card) throw new SimulationTargetNotFoundError("card");
  if (!card.providerId) throw new CardNotLinkedError(input.cardId);

  let cardPaymentId: string | undefined;
  if (simulation.action !== "authorize") {
    const [purchase] = await db
      .select({ providerObjectId: transactions.providerObjectId })
      .from(transactions)
      .where(
        and(
          eq(transactions.id, simulation.transactionId),
          eq(transactions.accountId, input.accountId),
          eq(transactions.type, "CARD_PURCHASE"),
          eq(transactions.provider, provider.name),
        ),
      );
    if (!purchase?.providerObjectId) throw new SimulationTargetNotFoundError("transaction");
    cardPaymentId = purchase.providerObjectId;
  }
  const txLog = log.child({ transaction_id: "transactionId" in simulation ? simulation.transactionId : undefined, provider_object_id: cardPaymentId });

  let result: SimulationResult;
  try {
    if (cardPaymentId) {
      const current = await provider.retrieveCardPayment(cardPaymentId);
      if (current.cardId !== card.providerId) throw new SimulationTargetNotFoundError("transaction");
      const settled = current.elements.some((element) => element.kind === "SETTLEMENT");
      if (simulation.action === "reverse" && simulation.amountCents !== undefined && !settled) {
        throw new PartialReversalNotSupportedError(cardPaymentId);
      }
    }
    if (simulation.action === "authorize") {
      result = await provider.simulateAuthorization({ cardId: card.providerId, amountCents: simulation.amountCents, merchant: simulation.merchant });
    } else if (simulation.action === "settle") {
      result = await provider.simulateSettlement({ cardPaymentId: cardPaymentId!, amountCents: simulation.amountCents });
    } else if (simulation.action === "reverse") {
      result = await provider.simulateReversal({ cardPaymentId: cardPaymentId!, amountCents: simulation.amountCents });
    } else {
      result = await provider.simulateExpiration({ cardPaymentId: cardPaymentId! });
    }
  } catch (error) {
    if (error instanceof SimulationTargetNotFoundError || error instanceof PartialReversalNotSupportedError) {
      txLog.info({ outcome: "refused", reason: error.name }, "card simulation refused; nothing sent to the provider");
      throw error;
    }
    const requestId = error instanceof Error && "requestId" in error ? error.requestId : undefined;
    txLog.error({ outcome: "provider_error", err: safeErrorForLog(error), provider_request_id: requestId }, "card simulation failed at the provider; nothing changed");
    throw error;
  }
  txLog.info(
    { outcome: result.declined ? "declined" : "requested", provider_object_id: result.cardPaymentId, provider_request_id: result.requestId },
    "card simulation requested; its effect arrives by webhook",
  );
  return result;
}
