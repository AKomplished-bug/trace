import { describe, expect, it } from "vitest";
import { fieldErrors, fundingFormSchema, paymentFormSchema, toCents } from "./money-forms";

const valid = { recipientName: "Globex Supplies", accountNumber: "123456789", routingNumber: "101050001", amount: "100.50", description: "" };

describe("toCents", () => {
  it("converts dollars to integer cents without floats", () => {
    expect(toCents("100")).toBe(10000);
    expect(toCents("100.5")).toBe(10050);
    expect(toCents(" 0.07 ")).toBe(7);
    expect(toCents("1,250.00")).toBe(125000);
  });

  it("refuses anything that isn't a plain dollar amount", () => {
    for (const value of ["", "abc", "1.234", "-5", "1e3", "12,34"]) expect(toCents(value)).toBeNull();
  });
});

describe("paymentFormSchema", () => {
  it("turns the form into the API body, dropping a blank description", () => {
    expect(paymentFormSchema.parse(valid)).toEqual({ recipientName: "Globex Supplies", accountNumber: "123456789", routingNumber: "101050001", amountCents: 10050 });
  });

  it("names each invalid field in a sentence, as the API would", () => {
    const result = paymentFormSchema.safeParse({ ...valid, routingNumber: "12345", amount: "0", accountNumber: "12" });
    expect(result.success).toBe(false);
    expect(fieldErrors(result.error!)).toEqual({
      accountNumber: "Account number must be 4 to 17 digits.",
      routingNumber: "Routing number must be 9 digits.",
      amount: "Enter an amount greater than $0.00.",
    });
  });

  it("rejects a routing number whose check digit doesn't match", () => {
    const result = paymentFormSchema.safeParse({ ...valid, routingNumber: "101050002" });
    expect(fieldErrors(result.error!).routingNumber).toMatch(/check digit/);
  });
});

describe("fundingFormSchema", () => {
  it("accepts dollars and refuses more than the funding limit", () => {
    expect(fundingFormSchema.parse({ amount: "500" })).toEqual({ amountCents: 50000 });
    expect(fieldErrors(fundingFormSchema.safeParse({ amount: "2000000" }).error!).amount).toBe("Enter $1,000,000 or less.");
  });
});
