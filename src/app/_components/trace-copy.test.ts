import { describe, expect, it } from "vitest";
import { DEMO } from "../../services/demo";
import type { TimelineStep } from "../../services/transaction-queries";
import { describeStep, stepAmount } from "./trace-copy";

const step = (kind: TimelineStep["kind"], amountCents: number | null, ledgerDeltaCents = 0) => ({ kind, amountCents, ledgerDeltaCents }) as TimelineStep;

describe("stepAmount", () => {
  it("signs postings, notes hold steps, and shows no amount for a status change", () => {
    expect(stepAmount(step("LEDGER_POSTED", -10000, -10000))).toEqual({ cents: -10000, signed: true });
    expect(stepAmount(step("HOLD_CREATED", 10000))).toEqual({ cents: 10000, signed: false, note: "held" });
    expect(stepAmount(step("HOLD_RELEASED", 10000))).toEqual({ cents: 10000, signed: false, note: "released" });
    expect(stepAmount(step("HOLD_EXPIRED", 8000))).toEqual({ cents: 8000, signed: false, note: "released" });
    expect(stepAmount(step("SETTLED_AFTER_HOLD_CLOSED", 8000))).toEqual({ cents: 8000, signed: false, note: "was held" });
    expect(stepAmount(step("STATUS_CHANGED", 10000))).toBeNull();
    expect(stepAmount(step("HOLD_EXCEEDS_AVAILABLE", 8000))).toBeNull();
    expect(stepAmount(step("SUBMITTED_TO_NETWORK", null))).toBeNull();
  });
});

describe("stepAmount on the demo card purchase ($80 authorized, $65 settled)", () => {
  it("never shows the authorized amount on the settled status step; only the posting moves money", () => {
    const { authorizedCents, settledCents } = DEMO;
    const trace = [
      step("HOLD_CREATED", authorizedCents),
      step("LEDGER_POSTED", settledCents, -settledCents),
      step("HOLD_RELEASED", authorizedCents),
      // "Merchant settled — purchase complete": the row carries the transaction's $80.
      { ...step("STATUS_CHANGED", authorizedCents), fromStatus: "AUTHORIZED", toStatus: "SETTLED" } as TimelineStep,
    ];
    expect(trace.map(stepAmount)).toEqual([
      { cents: 8000, signed: false, note: "held" },
      { cents: -6500, signed: true },
      { cents: 8000, signed: false, note: "released" },
      null,
    ]);
  });
});

describe("describeStep", () => {
  it("explains an adjustment's settlement as a reviewed correction, not a bare status", () => {
    const settled = { kind: "STATUS_CHANGED", fromStatus: null, toStatus: "SETTLED", amountCents: 1500, ledgerDeltaCents: 0 } as TimelineStep;
    expect(describeStep(settled, "ADJUSTMENT").title).toBe("Correction posted after review");
    expect(describeStep(settled, "ADJUSTMENT").detail).toContain("original transaction is unchanged");
    expect(describeStep(settled, "ADJUSTMENT").title).not.toContain("Status:");
  });
});
