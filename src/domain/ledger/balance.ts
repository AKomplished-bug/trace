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

export interface BalanceTerm {
  key: keyof Omit<BalanceExplanation, "availableCents">;
  label: string;
  /** How the term combines into the available balance. */
  operator: "+" | "−";
  description: string;
}

/**
 * The accounting model behind the available balance, term by term, in display order. The UI and
 * API render these; they don't restate the formula.
 */
export const BALANCE_TERMS: ReadonlyArray<BalanceTerm> = [
  {
    key: "ledgerBalanceCents",
    label: "Ledger balance",
    operator: "+",
    description: "Money that has actually moved: funding, card settlements, payments, refunds and returns.",
  },
  {
    key: "pendingCardHoldsCents",
    label: "Pending card holds",
    operator: "−",
    description: "Card authorizations that haven't settled yet. They reserve money without moving it.",
  },
  {
    key: "pendingPaymentsCents",
    label: "Pending payments",
    operator: "−",
    description: "Outbound payments that are on their way but not yet completed.",
  },
];

export const AVAILABLE_BALANCE_LABEL = "Available balance";

/** "Available balance = Ledger balance − Pending card holds − Pending payments" */
export const BALANCE_FORMULA = `${AVAILABLE_BALANCE_LABEL} = ${BALANCE_TERMS.map((term, i) =>
  i === 0 ? term.label : `${term.operator} ${term.label}`,
).join(" ")}`;

/** The explanation as display lines: each term with its amount, then the result. */
export function balanceExplanationLines(explanation: BalanceExplanation) {
  return {
    formula: BALANCE_FORMULA,
    lines: BALANCE_TERMS.map((term) => ({ ...term, amountCents: explanation[term.key] })),
    result: { label: AVAILABLE_BALANCE_LABEL, amountCents: explanation.availableCents },
  };
}
