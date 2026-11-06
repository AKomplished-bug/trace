import { describe, expect, it } from "vitest";
import { amountView } from "./labels";

const base = { amountCents: 8000, postedCents: null, holdCents: null, holdStatus: null } as const;

describe("amountView", () => {
  it("signs only amounts that posted to the ledger", () => {
    expect(amountView({ ...base, status: "SETTLED", postedCents: -6500, holdCents: 8000, holdStatus: "RELEASED" })).toEqual({ kind: "posted", cents: -6500 });
    expect(amountView({ ...base, status: "SETTLED", amountCents: 50000, postedCents: 50000 })).toEqual({ kind: "posted", cents: 50000 });
  });

  it("shows an active authorization as held, not as a debit", () => {
    expect(amountView({ ...base, status: "AUTHORIZED", holdCents: 8000, holdStatus: "ACTIVE" })).toEqual({ kind: "held", cents: 8000 });
  });

  it("shows money that never moved as void with its status", () => {
    expect(amountView({ ...base, status: "EXPIRED", holdCents: 8000, holdStatus: "EXPIRED" })).toEqual({ kind: "void", cents: 8000, status: "EXPIRED" });
    expect(amountView({ ...base, status: "AUTHORIZED", holdCents: 8000, holdStatus: "RELEASED" })).toEqual({ kind: "void", cents: 8000, status: "AUTHORIZED" });
    expect(amountView({ ...base, status: "FAILED", amountCents: 50000 })).toEqual({ kind: "void", cents: 50000, status: "FAILED" });
    expect(amountView({ ...base, status: "PENDING", amountCents: 50000 })).toEqual({ kind: "pending", cents: 50000, status: "PENDING" });
  });
});
