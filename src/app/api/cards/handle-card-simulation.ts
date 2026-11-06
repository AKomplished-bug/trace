import { z } from "zod";
import type { Db } from "../../../db/client";
import type { CardProvider } from "../../../integrations/card-provider";
import { PaymentProviderError, ProviderRejectedError } from "../../../integrations/payment-provider";
import type { Logger } from "../../../lib/logger";
import {
  CardNotLinkedError,
  PartialReversalNotSupportedError,
  simulateCardStep,
  SimulationTargetNotFoundError,
  type CardSimulation,
} from "../../../services/card-simulations";
import { invalidRequest, withRequestLog } from "../handler";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

export interface CardSimulationDeps {
  db: Db;
  provider: CardProvider;
  logger: Logger;
}

/** Largest single simulated card amount: $1,000,000. */
const MAX_CARD_CENTS = 100_000_000;
const cents = z
  .number({ error: "must be a number of cents" })
  .int("must be whole cents")
  .positive("must be positive")
  .max(MAX_CARD_CENTS, `must be at most ${MAX_CARD_CENTS} ($1,000,000)`);
const transactionId = z.uuid("must be a transaction id");

const bodySchemas = {
  authorize: z.object({ amountCents: cents, merchant: z.string().trim().min(1, "must not be empty").max(25, "must be at most 25 characters").optional() }),
  settle: z.object({ transactionId, amountCents: cents }),
  reverse: z.object({ transactionId, amountCents: cents.optional() }),
  expire: z.object({ transactionId }),
} as const;
export type CardSimulationAction = keyof typeof bodySchemas;

const cardParams = z.object({ id: z.uuid("must be a card id") });

/**
 * POST /api/cards/:id/{authorize,settle,reverse,expire} — sandbox only. `reverse` voids an
 * unsettled purchase in full (amountCents is refused with 422) or refunds a settled one, in part
 * if amountCents is given. Asks Increase to simulate
 * the step and answers 202 with what was requested; nothing changes here. The step reaches our
 * books through Increase's webhook and the worker, like a real card event.
 */
export async function handleCardSimulation(
  deps: CardSimulationDeps,
  action: CardSimulationAction,
  request: Request,
  params: { id: string },
): Promise<Response> {
  return withRequestLog(deps, `POST /api/cards/:id/${action}`, async ({ log, annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const card = cardParams.safeParse(params);
    if (!card.success) return invalidRequest(card.error);
    annotate({ card_id: card.data.id });
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON");
    }
    const body = bodySchemas[action].safeParse(json);
    if (!body.success) return invalidRequest(body.error);
    const simulation = { action, ...body.data } as CardSimulation;
    if ("transactionId" in simulation) annotate({ transaction_id: simulation.transactionId });

    try {
      const result = await simulateCardStep(deps.db, deps.provider, { accountId: owner.accountId, cardId: card.data.id, simulation }, log);
      annotate({ provider_object_id: result.cardPaymentId });
      return Response.json(
        { requested: { cardId: card.data.id, ...simulation }, cardPaymentId: result.cardPaymentId, declined: result.declined },
        { status: 202 },
      );
    } catch (error) {
      if (error instanceof SimulationTargetNotFoundError) {
        return error.target === "card"
          ? errorResponse(404, "card_not_found", "No card with that id on your account")
          : errorResponse(404, "transaction_not_found", "No purchase with that id on this card");
      }
      if (error instanceof CardNotLinkedError) {
        return errorResponse(409, "card_not_linked", "This card isn't linked to an Increase sandbox card yet; run npm run increase:bootstrap");
      }
      if (error instanceof PartialReversalNotSupportedError) {
        return errorResponse(422, "partial_reversal_not_supported", "Partial authorization reversals aren't supported; omit amountCents to void in full");
      }
      if (error instanceof ProviderRejectedError) {
        return errorResponse(422, "provider_rejected", "Increase refused this step for the purchase's current state; nothing changed");
      }
      if (error instanceof PaymentProviderError) {
        return errorResponse(
          502,
          "provider_unavailable",
          "Increase didn't answer in time; our records are unchanged. If Increase did apply the step, it arrives by webhook — check before retrying.",
        );
      }
      throw error;
    }
  });
}
