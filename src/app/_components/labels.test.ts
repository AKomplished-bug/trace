import { describe, expect, it } from "vitest";
import { amountView, counterparty, EVENT_STATUS_LABELS, isInFlight, maskedAccount, RECONCILIATION_STATUS_LABELS, STATUS_LABELS, STATUS_TONES } from "./labels";

const base = { amountCents: 8000, postedCents: null, holdCents: null, holdStatus: null } as const;

describe("amountView", () => {
  it("signs only amounts that posted to the ledger", () => {
    expect(amountView({ ...base, status: "SETTLED", postedCents: -6500, holdCents: 8000, holdStatus: "RELEASED" })).toEqual({ kind: "posted", cents: -6500 });
    expect(amountView({ ...base, status: "SETTLED", amountCents: 50000, postedCents: 50000 })).toEqual({ kind: "posted", cents: 50000 });
  });

  it("shows an active authorization as held, not as a debit", () => {
    expect(amountView({ ...base, status: "AUTHORIZED", holdCents: 8000, holdStatus: "ACTIVE" })).toEqual({ kind: "held", cents: 8000 });
  });

  it("shows an outbound payment as held until it completes, and unsigned once returned before settling", () => {
    for (const status of ["PENDING", "SUBMITTED"] as const) {
      expect(amountView({ ...base, status, amountCents: 10000, holdCents: 10000, holdStatus: "ACTIVE" })).toEqual({ kind: "held", cents: 10000 });
    }
    expect(amountView({ ...base, status: "COMPLETED", amountCents: 10000, postedCents: -10000, holdCents: 10000, holdStatus: "RELEASED" })).toEqual({ kind: "posted", cents: -10000 });
    expect(amountView({ ...base, status: "RETURNED", amountCents: 10000, holdCents: 10000, holdStatus: "RELEASED" })).toEqual({ kind: "void", cents: 10000, status: "RETURNED" });
  });

  it("shows money that never moved as void with its status", () => {
    expect(amountView({ ...base, status: "EXPIRED", holdCents: 8000, holdStatus: "EXPIRED" })).toEqual({ kind: "void", cents: 8000, status: "EXPIRED" });
    expect(amountView({ ...base, status: "AUTHORIZED", holdCents: 8000, holdStatus: "RELEASED" })).toEqual({ kind: "void", cents: 8000, status: "AUTHORIZED" });
    expect(amountView({ ...base, status: "FAILED", amountCents: 50000 })).toEqual({ kind: "void", cents: 50000, status: "FAILED" });
    expect(amountView({ ...base, status: "PENDING", amountCents: 50000 })).toEqual({ kind: "pending", cents: 50000, status: "PENDING" });
  });
});

describe("counterparty", () => {
  it("names a card purchase's merchant when the provider gave one", () => {
    expect(counterparty({ type: "CARD_PURCHASE", recipient: null, counterparty: "FIGMA.COM", provider: "increase" })).toBe("FIGMA.COM");
    expect(counterparty({ type: "CARD_PURCHASE", recipient: null, counterparty: null, provider: "demo" })).toBe("Virtual card");
    expect(counterparty({ type: "OUTBOUND_PAYMENT", recipient: "Acme Supplies", counterparty: null, provider: "increase" })).toBe("Acme Supplies");
  });
});

describe("isInFlight", () => {
  it("marks held and not-yet-moved amounts as pending, never posted or void ones", () => {
    expect(isInFlight({ kind: "held", cents: 8000 })).toBe(true);
    expect(isInFlight({ kind: "pending", cents: 8000, status: "PENDING" })).toBe(true);
    expect(isInFlight({ kind: "posted", cents: -6500 })).toBe(false);
    expect(isInFlight({ kind: "void", cents: 8000, status: "EXPIRED" })).toBe(false);
  });
});

describe("status labels", () => {
  it("gives every in-flight transaction status the pending tone", () => {
    expect(["PENDING", "AUTHORIZED", "SUBMITTED"].map((s) => STATUS_TONES[s as keyof typeof STATUS_TONES])).toEqual(["pending", "pending", "pending"]);
    expect(STATUS_TONES.FAILED).toBe("danger");
    expect(STATUS_LABELS.SUBMITTED).toBe("Submitted");
  });

  it("names Ops statuses in plain English, not enum values", () => {
    expect(EVENT_STATUS_LABELS.RETRY).toBe("Retrying");
    expect(RECONCILIATION_STATUS_LABELS.AMOUNT_MISMATCH).toBe("Amount mismatch");
    expect(RECONCILIATION_STATUS_LABELS.PENDING_EXTERNAL).toBe("Waiting on provider");
  });
});

describe("maskedAccount", () => {
  it("shows the last four digits only", () => {
    expect(maskedAccount("6789")).toBe("•••• 6789");
    expect(maskedAccount("123456789")).toBe("•••• 6789");
  });
});
