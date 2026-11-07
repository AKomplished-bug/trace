import type { Db } from "../../../../db/client";
import type { TransferProvider } from "../../../../integrations/transfer-provider";
import type { Logger } from "../../../../lib/logger";
import { CONFIRM_NOT_SENT_MIN_AGE_SECONDS, confirmPaymentNotSent, requeuePayment } from "../../../../services/ops-payments";
import { paymentIdParams } from "../../../_lib/schemas";
import { checkSameOrigin, invalidRequest, withRequestLog, type HandlerDeps } from "../../handler";
import { errorResponse } from "../../responses";
import { requireOps } from "../../session";

export interface OpsPaymentDeps {
  db: Db;
  provider: TransferProvider;
  logger: Logger;
}

const notFound = () => errorResponse(404, "payment_not_found", "No payment with that id");
const notGivenUp = (status: string) =>
  errorResponse(409, "payment_not_given_up", `Only payments the submitter gave up on can be resolved here; this one is ${status}${status === "PENDING" ? " and still being submitted" : ""}`);

/**
 * POST /api/ops/payments/:id/requeue — a given-up payment goes back to the submitter with a fresh
 * budget, audited. It resends with the same idempotency key. Anything else (including a second
 * click) is 409 and changes nothing.
 */
export async function handleRequeuePayment(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/payments/:id/requeue", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const parsed = paymentIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ payment_id: parsed.data.id });
    const result = await requeuePayment(deps.db, { paymentId: parsed.data.id, userId: ops.userId, correlationId });
    if (result.outcome === "not_found") return notFound();
    if (result.outcome === "not_given_up") return notGivenUp(result.status);
    log.info({ payment_id: result.payment.id, submit_attempts: result.payment.submitAttempts, user_id: ops.userId }, "given-up payment requeued by Ops");
    return Response.json({ payment: result.payment });
  });
}

/**
 * POST /api/ops/payments/:id/confirm-not-sent — after Increase confirms it has no transfer under
 * our key, a given-up payment is FAILED and its hold released, audited. 409 if it gave up under
 * 5 minutes ago, Increase has one, or the payment isn't (or is no longer) given up; 502 if
 * Increase can't be asked. Nothing changes on any of them.
 */
export async function handleConfirmPaymentNotSent(deps: OpsPaymentDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "POST /api/ops/payments/:id/confirm-not-sent", async ({ log, annotate, correlationId }) => {
    const ops = await requireOps(request);
    if (ops instanceof Response) return ops;
    annotate({ user_id: ops.userId });
    const crossOrigin = checkSameOrigin(request);
    if (crossOrigin) return crossOrigin;
    const parsed = paymentIdParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ payment_id: parsed.data.id });
    const result = await confirmPaymentNotSent(deps.db, deps.provider, { paymentId: parsed.data.id, userId: ops.userId, correlationId }, log);
    switch (result.outcome) {
      case "not_found":
        return notFound();
      case "not_given_up":
        return notGivenUp(result.status);
      case "too_soon":
        return errorResponse(
          409,
          "too_soon",
          `Wait until ${CONFIRM_NOT_SENT_MIN_AGE_SECONDS / 60} minutes after the submitter gave up, so Increase has caught up; nothing changed`,
        );
      case "transfer_exists":
        annotate({ provider_object_id: result.transferId });
        return errorResponse(409, "transfer_exists", `Increase has transfer ${result.transferId} for this payment, so it may have been sent; nothing changed`);
      case "provider_error":
        return errorResponse(502, "provider_unavailable", "Couldn't check with Increase whether the payment was sent; nothing changed, try again");
      case "changed":
        return errorResponse(409, "payment_changed", `The payment changed while Increase was being checked (now ${result.status}); nothing changed, reload and try again`);
      case "failed":
        return Response.json({ payment: result.payment });
    }
  });
}
