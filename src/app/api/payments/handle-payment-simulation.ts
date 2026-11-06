import { z } from "zod";
import type { Db } from "../../../db/client";
import { PaymentProviderError, ProviderRejectedError } from "../../../integrations/payment-provider";
import type { TransferProvider } from "../../../integrations/transfer-provider";
import type { Logger } from "../../../lib/logger";
import {
  PaymentNotSubmittedError,
  PaymentSimulationNotFoundError,
  simulatePaymentStep,
  type PaymentSimulation,
} from "../../../services/payment-simulations";
import { invalidRequest, withRequestLog } from "../handler";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

export interface PaymentSimulationDeps {
  db: Db;
  provider: TransferProvider;
  logger: Logger;
}

// The common return reasons; Increase defaults to no_account
// (https://increase.com/documentation/api/ach-transfers#sandbox-return-an-ach-transfer).
const RETURN_REASONS = [
  "no_account",
  "account_closed",
  "insufficient_fund",
  "invalid_account_number_structure",
  "credit_entry_refused_by_receiver",
  "payment_stopped",
] as const;

const bodySchemas = {
  submit: z.object({}),
  settle: z.object({}),
  return: z.object({ reason: z.enum(RETURN_REASONS).optional() }),
} as const;
export type PaymentSimulationAction = keyof typeof bodySchemas;

const paymentParams = z.object({ id: z.uuid("must be a payment id") });

/**
 * POST /api/payments/:id/{submit,settle,return} — sandbox only. Asks Increase to simulate the ACH
 * network step on the payment's transfer and answers 202 with what was requested; nothing changes
 * here. The step reaches our books through Increase's webhook and the worker, like a real one.
 * Body: optional (`{}`); `return` accepts `{ reason }`.
 */
export async function handlePaymentSimulation(
  deps: PaymentSimulationDeps,
  action: PaymentSimulationAction,
  request: Request,
  params: { id: string },
): Promise<Response> {
  return withRequestLog(deps, `POST /api/payments/:id/${action}`, async ({ log, annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const parsed = paymentParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ payment_id: parsed.data.id });
    let json: unknown = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        return errorResponse(400, "invalid_json", "Request body must be JSON (or empty)");
      }
    }
    const body = bodySchemas[action].safeParse(json);
    if (!body.success) return invalidRequest(body.error);
    const simulation = { action, ...body.data } as PaymentSimulation;

    try {
      const transfer = await simulatePaymentStep(deps.db, deps.provider, { accountId: owner.accountId, paymentId: parsed.data.id, simulation }, log);
      annotate({ provider_object_id: transfer.id });
      return Response.json({ requested: { paymentId: parsed.data.id, ...simulation }, achTransferId: transfer.id }, { status: 202 });
    } catch (error) {
      if (error instanceof PaymentSimulationNotFoundError) return errorResponse(404, "payment_not_found", "No payment with that id on your account");
      if (error instanceof PaymentNotSubmittedError) {
        return errorResponse(409, "payment_not_submitted", "This payment hasn't been sent to Increase yet; the worker submits it shortly");
      }
      if (error instanceof ProviderRejectedError) {
        return errorResponse(422, "provider_rejected", "Increase refused this step for the transfer's current state; nothing changed");
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
