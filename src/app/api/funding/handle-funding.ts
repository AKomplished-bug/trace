import { z } from "zod";
import type { Db } from "../../../db/client";
import { MAX_FUNDING_CENTS } from "../../../domain/funding";
import type { PaymentProvider } from "../../../integrations/payment-provider";
import { safeErrorForLog } from "../../../lib/errors";
import { newId } from "../../../lib/ids";
import type { Logger } from "../../../lib/logger";
import { createFunding, FundingProviderError, IdempotencyConflictError, type Transaction } from "../../../services/funding";
import { errorResponse } from "../responses";
import { requireOwner } from "../session";

export interface FundingDeps {
  db: Db;
  provider: PaymentProvider;
  logger: Logger;
}

const bodySchema = z.object({
  amountCents: z
    .number({ error: "amountCents must be a number of cents" })
    .int("amountCents must be whole cents")
    .positive("amountCents must be positive")
    .max(MAX_FUNDING_CENTS, `amountCents must be at most ${MAX_FUNDING_CENTS} ($1,000,000)`),
});
const idempotencyKeySchema = z.string().trim().min(1).max(255);

function view(transaction: Transaction) {
  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amountCents: transaction.amountCents,
    currency: transaction.currency,
    provider: transaction.provider,
    providerObjectId: transaction.providerObjectId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * POST /api/funding `{ amountCents }` with `Idempotency-Key`. 201 with the PENDING transaction;
 * the provider's webhook settles or fails it. A replay (same key, same body) returns the same
 * transaction with `Idempotent-Replayed: true`; the same key with a different body is 409.
 */
export async function handleFunding(deps: FundingDeps, request: Request): Promise<Response> {
  const owner = await requireOwner(request);
  if (owner instanceof Response) return owner;
  const correlationId = newId();
  const log = deps.logger.child({ correlation_id: correlationId, route: "POST /api/funding", user_id: owner.userId });

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
  if (!body.success) {
    const issue = body.error.issues[0];
    const message = issue.path.length ? issue.message : "Body must be an object like { \"amountCents\": 50000 }";
    return errorResponse(400, "invalid_request", message);
  }

  try {
    const { transaction, replayed } = await createFunding(
      deps.db,
      deps.provider,
      { accountId: owner.accountId, amountCents: body.data.amountCents, idempotencyKey: key.data },
      log,
    );
    return Response.json({ transaction: view(transaction) }, { status: 201, headers: replayed ? { "Idempotent-Replayed": "true" } : undefined });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      log.warn({ outcome: "idempotency_conflict", transaction_id: error.transactionId }, "Idempotency-Key reused with a different body");
      return errorResponse(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request body");
    }
    if (error instanceof FundingProviderError) {
      return errorResponse(
        502,
        "provider_unavailable",
        "The funding request is saved as pending, but the payment provider could not be reached. Retry with the same Idempotency-Key.",
      );
    }
    log.error({ outcome: "error", err: safeErrorForLog(error) }, "funding request failed");
    return errorResponse(500, "internal_error", "Something went wrong; retry with the same Idempotency-Key");
  }
}
