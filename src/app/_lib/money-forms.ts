import { z } from "zod";
import { MAX_FUNDING_CENTS } from "../../domain/funding";
import { isValidRoutingNumber, MAX_PAYMENT_CENTS } from "../../domain/payments";

// Client-safe (zod and pure domain only): the owner forms validate with the same rules as the API.

// Printable ASCII: what ACH name and descriptor fields accept.
const ascii = /^[\x20-\x7E]+$/;

/** POST /api/payments body. */
export const paymentBodySchema = z.object({
  // Increase's individual_name limit (https://increase.com/documentation/api/ach-transfers#create-an-ach-transfer).
  recipientName: z
    .string({ error: "must be the recipient's name" })
    .trim()
    .min(1, "must not be empty")
    .max(22, "must be at most 22 characters")
    .regex(ascii, "must use plain letters, digits and punctuation"),
  accountNumber: z.string({ error: "must be the recipient's account number" }).trim().regex(/^\d{4,17}$/, "must be 4 to 17 digits"),
  routingNumber: z
    .string({ error: "must be the recipient bank's routing number" })
    .trim()
    .regex(/^\d{9}$/, "must be 9 digits")
    .refine(isValidRoutingNumber, "is not a valid ABA routing number (check digit doesn't match)"),
  amountCents: z
    .number({ error: "must be a number of cents" })
    .int("must be whole cents")
    .positive("must be positive")
    .max(MAX_PAYMENT_CENTS, `must be at most ${MAX_PAYMENT_CENTS} ($1,000,000)`),
  description: z
    .string({ error: "must be text" })
    .trim()
    .min(1, "must not be empty when given")
    .max(80, "must be at most 80 characters")
    .regex(ascii, "must use plain letters, digits and punctuation")
    .optional(),
});

/** "100", "100.5", "100.50", "1,250.00" → cents, with string math only (never floats); null if it isn't an amount. */
export function toCents(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim().replace(/,(?=\d{3}(?:\D|$))/g, ""));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** A dollar amount typed into a form → cents, between one cent and `maxCents`. */
const dollars = (maxCents: number) =>
  z
    .string()
    .transform((value, ctx) => {
      const cents = toCents(value);
      if (cents === null) {
        ctx.addIssue({ code: "custom", message: "Enter an amount in dollars, like 100 or 100.50" });
        return z.NEVER;
      }
      return cents;
    })
    .pipe(
      z
        .number()
        .positive("Enter an amount greater than $0.00")
        .max(maxCents, `Enter $${(maxCents / 100).toLocaleString("en-US")} or less`),
    );

const blankAsUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

/** The Send payment form's fields (strings) → the POST /api/payments body. */
export const paymentFormSchema = paymentBodySchema
  .omit({ amountCents: true, description: true })
  .extend({ amount: dollars(MAX_PAYMENT_CENTS), description: z.preprocess(blankAsUndefined, paymentBodySchema.shape.description) })
  .transform(({ amount, ...rest }) => ({ ...rest, amountCents: amount }));

/** The Fund account form → the POST /api/funding body. */
export const fundingFormSchema = z.object({ amount: dollars(MAX_FUNDING_CENTS) }).transform(({ amount }) => ({ amountCents: amount }));

const FIELD_NAMES: Record<string, string> = {
  recipientName: "Recipient",
  accountNumber: "Account number",
  routingNumber: "Routing number",
  description: "Description",
};

/** The first problem per field, as a sentence: "must be 9 digits" → "Routing number must be 9 digits." */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (result[field]) continue;
    const message = /^[A-Z]/.test(issue.message) ? issue.message : `${FIELD_NAMES[field] ?? "This field"} ${issue.message}`;
    result[field] = message.endsWith(".") ? message : `${message}.`;
  }
  return result;
}
