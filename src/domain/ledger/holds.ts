/**
 * Holds reserve funds without touching the ledger: card authorizations and pending outbound
 * payments. Only ACTIVE holds reduce the available balance.
 */
export const HOLD_KINDS = ["CARD_AUTHORIZATION", "PENDING_PAYMENT"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export const HOLD_STATUSES = ["ACTIVE", "RELEASED", "EXPIRED"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

/** RELEASE: settled, completed or cancelled. EXPIRE: authorization lapsed without settlement. */
export type HoldEvent = "RELEASE" | "EXPIRE";

const TRANSITIONS: Record<HoldStatus, Partial<Record<HoldEvent, HoldStatus>>> = {
  ACTIVE: { RELEASE: "RELEASED", EXPIRE: "EXPIRED" },
  RELEASED: {},
  EXPIRED: {},
};

export class IllegalHoldTransitionError extends Error {
  constructor(
    readonly from: HoldStatus,
    readonly event: HoldEvent,
  ) {
    super(`Illegal hold transition: ${event} from ${from}`);
    this.name = "IllegalHoldTransitionError";
  }
}

/** Next status for `event`, or throws if the hold can't make that move (e.g. it is already terminal). */
export function nextHoldStatus(from: HoldStatus, event: HoldEvent): HoldStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new IllegalHoldTransitionError(from, event);
  return to;
}
