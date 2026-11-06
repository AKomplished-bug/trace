import type { HoldKind, HoldStatus } from "./holds";

export interface HoldAmount {
  kind: HoldKind;
  status: HoldStatus;
  amountCents: number;
}

export interface BalanceExplanation {
  ledgerBalanceCents: number;
  pendingCardHoldsCents: number;
  pendingPaymentsCents: number;
  availableCents: number;
}

function activeCents(holds: ReadonlyArray<HoldAmount>, kind?: HoldKind): number {
  return holds
    .filter((hold) => hold.status === "ACTIVE" && (kind === undefined || hold.kind === kind))
    .reduce((sum, hold) => sum + hold.amountCents, 0);
}

/** Available = ledger balance − SUM(active holds). Nothing else reduces it. */
export function availableCents(ledgerBalanceCents: number, holds: ReadonlyArray<HoldAmount>): number {
  return ledgerBalanceCents - activeCents(holds);
}

/** The breakdown behind the available balance, line by line. */
export function explainBalance(ledgerBalanceCents: number, holds: ReadonlyArray<HoldAmount>): BalanceExplanation {
  return {
    ledgerBalanceCents,
    pendingCardHoldsCents: activeCents(holds, "CARD_AUTHORIZATION"),
    pendingPaymentsCents: activeCents(holds, "PENDING_PAYMENT"),
    availableCents: availableCents(ledgerBalanceCents, holds),
  };
}
