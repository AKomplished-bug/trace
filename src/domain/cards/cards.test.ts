import { describe, expect, it } from "vitest";
import { nextCardPurchaseStatus } from ".";

describe("card purchase transitions", () => {
  it("moves an authorized purchase to SETTLED, REVERSED or EXPIRED", () => {
    expect(nextCardPurchaseStatus("AUTHORIZED", "SETTLE")).toBe("SETTLED");
    expect(nextCardPurchaseStatus("AUTHORIZED", "VOID")).toBe("REVERSED");
    expect(nextCardPurchaseStatus("AUTHORIZED", "EXPIRE")).toBe("EXPIRED");
  });

  it("still settles after a void or expiry (late capture)", () => {
    expect(nextCardPurchaseStatus("EXPIRED", "SETTLE")).toBe("SETTLED");
    expect(nextCardPurchaseStatus("REVERSED", "SETTLE")).toBe("SETTLED");
  });

  it.each([
    ["SETTLED", "SETTLE"],
    ["SETTLED", "VOID"],
    ["SETTLED", "EXPIRE"],
    ["EXPIRED", "VOID"],
    ["REVERSED", "EXPIRE"],
    ["PENDING", "SETTLE"],
  ] as const)("has no move from %s on %s", (from, event) => {
    expect(nextCardPurchaseStatus(from, event)).toBeNull();
  });
});
