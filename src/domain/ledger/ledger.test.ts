import { describe, expect, it } from "vitest";
import {
  assertEntryTypeForTransaction,
  assertLedgerEntryAmount,
  ENTRY_TYPE_FOR_TRANSACTION,
  availableCents,
  explainBalance,
  IllegalHoldTransitionError,
  InvalidLedgerEntryError,
  ledgerBalanceCents,
  nextHoldStatus,
  type HoldAmount,
  type LedgerEntryType,
  type TransactionType,
} from ".";

type Entry = { entryType: LedgerEntryType; amountCents: number };

function post(entries: Entry[], entry: Entry): Entry[] {
  assertLedgerEntryAmount(entry.entryType, entry.amountCents);
  return [...entries, entry];
}

function release(hold: HoldAmount): HoldAmount {
  return { ...hold, status: nextHoldStatus(hold.status, "RELEASE") };
}

function expire(hold: HoldAmount): HoldAmount {
  return { ...hold, status: nextHoldStatus(hold.status, "EXPIRE") };
}

const funded = post([], { entryType: "FUNDING_CREDIT", amountCents: 50000 });
const auth80: HoldAmount = { kind: "CARD_AUTHORIZATION", status: "ACTIVE", amountCents: 8000 };

describe("card lifecycle balances (spec §5–6, §27)", () => {
  it("funding $500 makes ledger and available $500", () => {
    const ledger = ledgerBalanceCents(funded);
    expect(ledger).toBe(50000);
    expect(availableCents(ledger, [])).toBe(50000);
  });

  it("authorizing $80 holds funds without touching the ledger: 500 / 420", () => {
    const ledger = ledgerBalanceCents(funded);
    expect(explainBalance(ledger, [auth80])).toEqual({
      ledgerBalanceCents: 50000,
      pendingCardHoldsCents: 8000,
      pendingPaymentsCents: 0,
      availableCents: 42000,
    });
  });

  it("settling $65 and releasing the $80 hold gives 435 / 435", () => {
    const entries = post(funded, { entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500 });
    const holds = [release(auth80)];
    expect(explainBalance(ledgerBalanceCents(entries), holds)).toEqual({
      ledgerBalanceCents: 43500,
      pendingCardHoldsCents: 0,
      pendingPaymentsCents: 0,
      availableCents: 43500,
    });
  });

  it("a +$65 reversal nets the purchase to zero", () => {
    const settlement: Entry = { entryType: "CARD_SETTLEMENT_DEBIT", amountCents: -6500 };
    const reversal: Entry = { entryType: "CARD_REVERSAL_CREDIT", amountCents: 6500 };
    const entries = post(post(funded, settlement), reversal);
    expect(ledgerBalanceCents([settlement, reversal])).toBe(0);
    expect(ledgerBalanceCents(entries)).toBe(50000);
    expect(availableCents(ledgerBalanceCents(entries), [release(auth80)])).toBe(50000);
  });

  it("an expired authorization releases the hold with no ledger change", () => {
    const holds = [expire(auth80)];
    expect(explainBalance(ledgerBalanceCents(funded), holds)).toEqual({
      ledgerBalanceCents: 50000,
      pendingCardHoldsCents: 0,
      pendingPaymentsCents: 0,
      availableCents: 50000,
    });
    expect(funded).toHaveLength(1);
  });

  it("pending outbound payments reduce available, not ledger", () => {
    const payment: HoldAmount = { kind: "PENDING_PAYMENT", status: "ACTIVE", amountCents: 10000 };
    expect(explainBalance(50000, [auth80, payment])).toEqual({
      ledgerBalanceCents: 50000,
      pendingCardHoldsCents: 8000,
      pendingPaymentsCents: 10000,
      availableCents: 32000,
    });
  });
});

describe("hold transitions", () => {
  it("moves ACTIVE to RELEASED or EXPIRED", () => {
    expect(nextHoldStatus("ACTIVE", "RELEASE")).toBe("RELEASED");
    expect(nextHoldStatus("ACTIVE", "EXPIRE")).toBe("EXPIRED");
  });

  it.each([
    ["RELEASED", "RELEASE"],
    ["RELEASED", "EXPIRE"],
    ["EXPIRED", "RELEASE"],
    ["EXPIRED", "EXPIRE"],
  ] as const)("rejects %s → %s", (from, event) => {
    expect(() => nextHoldStatus(from, event)).toThrow(IllegalHoldTransitionError);
  });

  it("a hold can't be released twice, so settlement can't free funds twice", () => {
    expect(() => release(release(auth80))).toThrow("Illegal hold transition: RELEASE from RELEASED");
  });
});

describe("ledger entry direction", () => {
  it.each([
    ["FUNDING_CREDIT", -50000],
    ["CARD_SETTLEMENT_DEBIT", 6500],
    ["CARD_REVERSAL_CREDIT", -6500],
    ["PAYMENT_DEBIT", 10000],
    ["PAYMENT_RETURN_CREDIT", -10000],
  ] as const)("rejects %s with the wrong sign (%i)", (entryType, amountCents) => {
    expect(() => assertLedgerEntryAmount(entryType, amountCents)).toThrow(InvalidLedgerEntryError);
  });

  it("rejects zero and fractional amounts", () => {
    expect(() => assertLedgerEntryAmount("ADJUSTMENT", 0)).toThrow(InvalidLedgerEntryError);
    expect(() => assertLedgerEntryAmount("FUNDING_CREDIT", 65.5)).toThrow(InvalidLedgerEntryError);
  });

  it("allows adjustments in either direction", () => {
    expect(() => assertLedgerEntryAmount("ADJUSTMENT", 1500)).not.toThrow();
    expect(() => assertLedgerEntryAmount("ADJUSTMENT", -1500)).not.toThrow();
  });
});

describe("entry type per transaction type", () => {
  it("accepts the entry type each transaction type posts", () => {
    for (const [transactionType, entryType] of Object.entries(ENTRY_TYPE_FOR_TRANSACTION)) {
      expect(() => assertEntryTypeForTransaction(transactionType as TransactionType, entryType)).not.toThrow();
    }
  });

  it.each([
    ["FUNDING", "ADJUSTMENT"],
    ["CARD_PURCHASE", "CARD_REVERSAL_CREDIT"],
    ["CARD_REVERSAL", "CARD_SETTLEMENT_DEBIT"],
    ["OUTBOUND_PAYMENT", "PAYMENT_RETURN_CREDIT"],
    ["ADJUSTMENT", "FUNDING_CREDIT"],
  ] as const)("rejects %s posting %s", (transactionType, entryType) => {
    expect(() => assertEntryTypeForTransaction(transactionType, entryType)).toThrow(InvalidLedgerEntryError);
  });
});
