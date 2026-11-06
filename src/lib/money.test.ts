import { describe, expect, it } from "vitest";
import { assertCents, formatCents } from "./money";

describe("formatCents", () => {
  it("formats integer cents as USD", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(43500)).toBe("$435.00");
    expect(formatCents(-8000)).toBe("-$80.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("adds a plus sign to credits when signed", () => {
    expect(formatCents(6500, { signed: true })).toBe("+$65.00");
    expect(formatCents(-6500, { signed: true })).toBe("-$65.00");
    expect(formatCents(0, { signed: true })).toBe("$0.00");
  });
});

describe("assertCents", () => {
  it("rejects floats and unsafe integers", () => {
    expect(() => assertCents(80.5)).toThrow("integer cents");
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow("integer cents");
    expect(assertCents(-500)).toBe(-500);
  });
});
