import { z } from "zod";
import { externalEventStatus, transactionStatus, transactionType } from "../../db/schema";
import { INCREASE_PROVIDER } from "../../integrations/increase";
import { STRIPE_PROVIDER } from "../../integrations/stripe";
import { decodeCursor } from "../../services/transaction-queries";

// Empty form fields (an "All" option in a filter) count as absent.
const blankAsUndefined = (value: unknown) => (value === "" ? undefined : value);

export const PAGE_SIZE = 25;

/** GET /api/transactions and the activity page. */
export const transactionListQuery = z.object({
  type: z.preprocess(blankAsUndefined, z.enum(transactionType.enumValues).optional()),
  status: z.preprocess(blankAsUndefined, z.enum(transactionStatus.enumValues).optional()),
  limit: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(100).default(PAGE_SIZE)),
  cursor: z.preprocess(
    blankAsUndefined,
    z
      .string()
      .max(500)
      .transform((value, ctx) => {
        const cursor = decodeCursor(value);
        if (!cursor) ctx.addIssue({ code: "custom", message: "is not a valid page cursor" });
        return cursor ?? undefined;
      })
      .optional(),
  ),
});

export const transactionIdParams = z.object({ id: z.uuid("must be a transaction id") });

export const EVENT_PROVIDERS = [STRIPE_PROVIDER, INCREASE_PROVIDER] as const;

/** GET /api/ops/events and the Ops event viewer. */
export const eventListQuery = z.object({
  status: z.preprocess(blankAsUndefined, z.enum(externalEventStatus.enumValues).optional()),
  provider: z.preprocess(blankAsUndefined, z.enum(EVENT_PROVIDERS).optional()),
  type: z.preprocess(blankAsUndefined, z.string().trim().min(1).max(100, "must be at most 100 characters").optional()),
  limit: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(100).default(PAGE_SIZE)),
  cursor: z.preprocess(
    blankAsUndefined,
    z
      .string()
      .max(500)
      .transform((value, ctx) => {
        const cursor = decodeCursor(value);
        if (!cursor) ctx.addIssue({ code: "custom", message: "is not a valid page cursor" });
        return cursor ?? undefined;
      })
      .optional(),
  ),
});

export const eventIdParams = z.object({ id: z.uuid("must be an event id") });

export const paymentIdParams = z.object({ id: z.uuid("must be a payment id") });

/** URLSearchParams → plain object; a repeated key keeps its first value. */
export function searchParamsObject(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of params) result[key] ??= value;
  return result;
}
