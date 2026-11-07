import { z } from "zod";
import type { Db } from "../../../db/client";
import { formatCents } from "../../../lib/money";
import type { Logger } from "../../../lib/logger";
import { IdempotencyConflictError } from "../../../services/funding";
import { getPayment, listPayments } from "../../../services/payment-queries";
import { AccountNotLinkedError, createPayment, InsufficientFundsError } from "../../../services/payments";
import { paymentBodySchema } from "../../_lib/money-forms";
import { PAGE_SIZE, searchParamsObject } from "../../_lib/schemas";
import { decodeCursor } from "../../../services/transaction-queries";
import { invalidRequest, withRequestLog, type HandlerDeps } from "../handler";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

export interface PaymentDeps {
  db: Db;
  /** The provider the payment will be sent through (the submitter calls it, not this handler). */
  provider: { name: string };
  logger: Logger;
}

const bodySchema = paymentBodySchema;
const idempotencyKeySchema = z.string().trim().min(1).max(255);
const paymentParams = z.object({ id: z.uuid("must be a payment id") });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
  cursor: z
    .string()
    .max(500)
    .transform((value, ctx) => {
      const cursor = decodeCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "is not a valid page cursor" });
      return cursor ?? undefined;
    })
    .optional(),
});

/**
 * POST /api/payments `{ recipientName, accountNumber, routingNumber, amountCents, description? }`
 * with `Idempotency-Key`. 201 with the PENDING payment (account number as its last four digits);
 * the worker submits it to Increase and webhooks move it on. A replay returns the same payment
 * with `Idempotent-Replayed: true`; the same key with a different body is 409. 422 when the
 * available balance can't cover it (nothing is created).
 */
export async function handleCreatePayment(deps: PaymentDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "POST /api/payments", async ({ log, annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });

    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key") ?? "");
    if (!key.success) {
      return errorResponse(400, "invalid_idempotency_key", "Idempotency-Key header is required (1-255 characters)");
    }
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON");
    }
    const body = bodySchema.safeParse(json);
    if (!body.success) return invalidRequest(body.error);

    try {
      const { payment, replayed } = await createPayment(
        deps.db,
        deps.provider,
        { accountId: owner.accountId, ...body.data, description: body.data.description ?? null, idempotencyKey: key.data },
        log,
      );
      annotate({ payment_id: payment.id, transaction_id: payment.transactionId, replayed });
      const view = await getPayment(deps.db, owner.accountId, payment.id);
      return Response.json({ payment: view }, { status: 201, headers: replayed ? { "Idempotent-Replayed": "true" } : undefined });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        annotate({ transaction_id: error.transactionId });
        return errorResponse(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request body");
      }
      if (error instanceof InsufficientFundsError) {
        return errorResponse(
          422,
          "insufficient_funds",
          `Available balance is ${formatCents(error.availableCents)}; this payment needs ${formatCents(error.amountCents)}. Nothing was sent.`,
        );
      }
      if (error instanceof AccountNotLinkedError) {
        return errorResponse(409, "account_not_linked", "This account isn't linked to an Increase sandbox account yet; run npm run increase:bootstrap");
      }
      throw error;
    }
  });
}

/** GET /api/payments — newest first. Query: limit (1–100), cursor. */
export async function handleListPayments(deps: HandlerDeps, request: Request): Promise<Response> {
  return withRequestLog(deps, "GET /api/payments", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const query = listQuery.safeParse(searchParamsObject(new URL(request.url).searchParams));
    if (!query.success) return invalidRequest(query.error);
    return Response.json(await listPayments(deps.db, owner.accountId, query.data));
  });
}

/** GET /api/payments/:id — another business's payment is a 404, like a missing one. */
export async function handleGetPayment(deps: HandlerDeps, request: Request, params: { id: string }): Promise<Response> {
  return withRequestLog(deps, "GET /api/payments/:id", async ({ annotate }) => {
    const owner = await requireOwner(request);
    if (owner instanceof Response) return owner;
    annotate({ user_id: owner.userId, account_id: owner.accountId });
    const parsed = paymentParams.safeParse(params);
    if (!parsed.success) return invalidRequest(parsed.error);
    annotate({ payment_id: parsed.data.id });
    const payment = await getPayment(deps.db, owner.accountId, parsed.data.id);
    return payment ? Response.json({ payment }) : errorResponse(404, "payment_not_found", "No payment with that id on your account");
  });
}
