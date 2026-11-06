import { describe, expect, it } from "vitest";
import { fundingOutcomeStatus, IllegalFundingTransitionError, nextFundingStatus } from ".";

describe("nextFundingStatus", () => {
  it("moves PENDING to SETTLED on confirmation and FAILED on failure", () => {
    expect(nextFundingStatus("PENDING", "FUNDING_CONFIRMED")).toBe("SETTLED");
    expect(nextFundingStatus("PENDING", "FUNDING_FAILED")).toBe("FAILED");
  });

  it("refuses to move a final transaction, or one in a non-funding status", () => {
    for (const [from, event] of [
      ["SETTLED", "FUNDING_FAILED"],
      ["FAILED", "FUNDING_CONFIRMED"],
      ["SETTLED", "FUNDING_CONFIRMED"],
      ["AUTHORIZED", "FUNDING_CONFIRMED"],
    ] as const) {
      expect(() => nextFundingStatus(from, event)).toThrow(IllegalFundingTransitionError);
    }
  });

  it("names the status each outcome leads to", () => {
    expect(fundingOutcomeStatus("FUNDING_CONFIRMED")).toBe("SETTLED");
    expect(fundingOutcomeStatus("FUNDING_FAILED")).toBe("FAILED");
  });
});
