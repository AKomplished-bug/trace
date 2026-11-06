import type { transactions } from "../../db/schema";
import type { LedgerEntryType } from "../../domain/ledger";

type Transaction = typeof transactions.$inferSelect;
export type TransactionType = Transaction["type"];
export type TransactionStatus = Transaction["status"];

/** Owner-facing names (spec §38): no provider or database vocabulary. */
export const TYPE_LABELS: Record<TransactionType, string> = {
  FUNDING: "Account funding",
  CARD_PURCHASE: "Card purchase",
  CARD_REVERSAL: "Card refund",
  OUTBOUND_PAYMENT: "Outgoing payment",
  PAYMENT_RETURN: "Returned payment",
  ADJUSTMENT: "Adjustment",
};

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  SETTLED: "Settled",
  COMPLETED: "Completed",
  REVERSED: "Reversed",
  RETURNED: "Returned",
  EXPIRED: "Expired",
  FAILED: "Failed",
};

export const PROVIDER_LABELS: Record<string, string> = {
  stripe: "Stripe",
  increase: "Increase",
  demo: "Demo data",
};

export function providerLabel(provider: string | null): string {
  return provider ? (PROVIDER_LABELS[provider] ?? provider) : "Trace";
}

/** Who or what the money moved to or from, as far as we know it. */
export function counterparty(t: { type: TransactionType; recipient: string | null; provider: string | null }): string {
  if (t.recipient) return t.recipient;
  if (t.type === "FUNDING") return `Funding via ${providerLabel(t.provider)}`;
  if (t.type === "CARD_PURCHASE" || t.type === "CARD_REVERSAL") return "Virtual card";
  return TYPE_LABELS[t.type];
}

/**
 * How to show a transaction's amount without implying money moved when it didn't:
 * - `posted`: it hit the ledger — the signed ledger amount.
 * - `held`: an active hold — the reserved amount, unsigned, "on hold".
 * - `void`: it ended without moving money (failed funding, expired or released authorization) —
 *   neutral and struck through, with the status.
 * - `pending`: nothing has happened yet (e.g. funding waiting on the provider) — neutral.
 */
export type AmountView =
  | { kind: "posted"; cents: number }
  | { kind: "held"; cents: number }
  | { kind: "void"; cents: number; status: TransactionStatus }
  | { kind: "pending"; cents: number; status: TransactionStatus };

export function amountView(t: {
  status: TransactionStatus;
  amountCents: number;
  postedCents: number | null;
  holdCents: number | null;
  holdStatus: "ACTIVE" | "RELEASED" | "EXPIRED" | null;
}): AmountView {
  if (t.postedCents !== null) return { kind: "posted", cents: t.postedCents };
  if (t.holdStatus === "ACTIVE") return { kind: "held", cents: t.holdCents ?? t.amountCents };
  const ended = t.status === "FAILED" || t.status === "EXPIRED" || t.holdStatus !== null;
  return { kind: ended ? "void" : "pending", cents: t.amountCents, status: t.status };
}

export const ENTRY_LABELS: Record<LedgerEntryType, string> = {
  FUNDING_CREDIT: "Funding credit",
  CARD_SETTLEMENT_DEBIT: "Card settlement debit",
  CARD_REVERSAL_CREDIT: "Card refund credit",
  PAYMENT_DEBIT: "Payment debit",
  PAYMENT_RETURN_CREDIT: "Payment return credit",
  ADJUSTMENT: "Adjustment",
};
