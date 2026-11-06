import { describe, expect, it } from "vitest";
import type { TimelineStep } from "../../services/transaction-queries";
import { stepAmount } from "./trace-copy";

const step = (kind: TimelineStep["kind"], amountCents: number | null, ledgerDeltaCents = 0) => ({ kind, amountCents, ledgerDeltaCents }) as TimelineStep;

describe("stepAmount", () => {
  it("signs postings, notes hold steps, and shows a status change's amount without a note", () => {
    expect(stepAmount(step("LEDGER_POSTED", -10000, -10000))).toEqual({ cents: -10000, signed: true });
    expect(stepAmount(step("HOLD_CREATED", 10000))).toEqual({ cents: 10000, signed: false, note: "held" });
    expect(stepAmount(step("HOLD_RELEASED", 10000))).toEqual({ cents: 10000, signed: false, note: "released" });
    expect(stepAmount(step("HOLD_EXPIRED", 8000))).toEqual({ cents: 8000, signed: false, note: "released" });
    expect(stepAmount(step("SETTLED_AFTER_HOLD_CLOSED", 8000))).toEqual({ cents: 8000, signed: false, note: "was held" });
    // "Payment requested $100.00", "Funding requested $500.00" — not "released".
    expect(stepAmount(step("STATUS_CHANGED", 10000))).toEqual({ cents: 10000, signed: false });
    expect(stepAmount(step("HOLD_EXCEEDS_AVAILABLE", 8000))).toBeNull();
    expect(stepAmount(step("SUBMITTED_TO_NETWORK", null))).toBeNull();
  });
});
