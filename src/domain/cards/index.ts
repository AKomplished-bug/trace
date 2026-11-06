/**
 * Card purchases. A CARD_PURCHASE transaction starts AUTHORIZED (an ACTIVE hold, no ledger
 * entry) and moves once: SETTLED (ledger debit, hold released), REVERSED (authorization voided,
 * hold released) or EXPIRED (hold expired). A late settlement after a void or expiry still
 * settles: the provider has moved the money. Money returned after settlement is a separate
 * CARD_REVERSAL transaction, so the purchase stays SETTLED.
 */

export type CardPurchaseStatus = "AUTHORIZED" | "SETTLED" | "REVERSED" | "EXPIRED";

/** What a lifecycle step does to the purchase. */
export type CardPurchaseEvent = "SETTLE" | "VOID" | "EXPIRE";

const TRANSITIONS: Record<CardPurchaseStatus, Partial<Record<CardPurchaseEvent, CardPurchaseStatus>>> = {
  AUTHORIZED: { SETTLE: "SETTLED", VOID: "REVERSED", EXPIRE: "EXPIRED" },
  REVERSED: { SETTLE: "SETTLED" },
  EXPIRED: { SETTLE: "SETTLED" },
  SETTLED: {},
};

function isCardPurchaseStatus(status: string): status is CardPurchaseStatus {
  return Object.hasOwn(TRANSITIONS, status);
}

/** The status `event` moves a purchase in `from` to, or null if it can't move from there. */
export function nextCardPurchaseStatus(from: string, event: CardPurchaseEvent): CardPurchaseStatus | null {
  return (isCardPurchaseStatus(from) && TRANSITIONS[from][event]) || null;
}

/**
 * Provider-neutral steps of one card payment, in the order they happened. Each has the
 * provider's id for that step, which we record (as `provider_ref`, or the CARD_REVERSAL's
 * `provider_object_id`) so a step is applied at most once. Amounts are positive integer cents.
 */
export type CardPaymentElement =
  | {
      kind: "AUTHORIZATION";
      id: string;
      amountCents: number;
      merchant: string | null;
      expiresAt: Date | null;
    }
  | { kind: "SETTLEMENT"; id: string; amountCents: number }
  /** Cancels (part of) an authorization before settlement; never moves settled money. */
  | { kind: "REVERSAL"; id: string; amountCents: number; remainingAuthorizationCents: number }
  | { kind: "EXPIRATION"; id: string; amountCents: number }
  /** Money back after settlement. */
  | { kind: "REFUND"; id: string; amountCents: number; merchant: string | null }
  /** A step that moves no money and holds nothing (e.g. a decline or a 3DS check). */
  | { kind: "NO_EFFECT"; id: string; category: string }
  /** A step we don't model (e.g. an increment); applying it automatically would be a guess. */
  | { kind: "UNSUPPORTED"; id: string; category: string; reason: string };
