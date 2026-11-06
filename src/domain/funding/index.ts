/**
 * Funding: money in from a payment provider. A FUNDING transaction starts PENDING when the owner
 * asks for it and moves once, on the provider's final outcome, to SETTLED (ledger credited) or
 * FAILED (no ledger effect).
 */

/** Internal events providers' funding outcomes map to (e.g. Stripe payment_intent.succeeded). */
export const FUNDING_EVENTS = ["FUNDING_CONFIRMED", "FUNDING_FAILED"] as const;
export type FundingEvent = (typeof FUNDING_EVENTS)[number];

export type FundingStatus = "PENDING" | "SETTLED" | "FAILED";

/** Largest single funding request: $1,000,000. */
export const MAX_FUNDING_CENTS = 100_000_000;

const TRANSITIONS: Record<FundingStatus, Partial<Record<FundingEvent, FundingStatus>>> = {
  PENDING: { FUNDING_CONFIRMED: "SETTLED", FUNDING_FAILED: "FAILED" },
  SETTLED: {},
  FAILED: {},
};

export class IllegalFundingTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly event: FundingEvent,
  ) {
    super(`Illegal funding transition: ${event} from ${from}`);
    this.name = "IllegalFundingTransitionError";
  }
}

function isFundingStatus(status: string): status is FundingStatus {
  return Object.hasOwn(TRANSITIONS, status);
}

/** Next status for `event`, or throws if the transaction can't make that move. */
export function nextFundingStatus(from: string, event: FundingEvent): FundingStatus {
  const to = isFundingStatus(from) ? TRANSITIONS[from][event] : undefined;
  if (!to) throw new IllegalFundingTransitionError(from, event);
  return to;
}

/** The status `event` leads to; a transaction already there has seen this outcome (a duplicate). */
export function fundingOutcomeStatus(event: FundingEvent): FundingStatus {
  return nextFundingStatus("PENDING", event);
}
