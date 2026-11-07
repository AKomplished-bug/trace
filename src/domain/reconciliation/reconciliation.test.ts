import { describe, expect, it } from "vitest";
import type { CardPaymentElement } from "../cards";
import type { TransferSnapshot } from "../payments";
import {
  cardPaymentRecords,
  classify,
  countByStatus,
  fundingRecord,
  internalAmountCents,
  suggestedAdjustmentCents,
  transferRecords,
  type ClassifyOptions,
  type ExternalRecord,
  type InternalRecord,
} from ".";

const HOUR = 3_600_000;
const asOf = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(asOf.getTime() - ms);
const options: ClassifyOptions = { window: { start: ago(24 * HOUR), end: asOf }, asOf, graceMs: HOUR };
const old = ago(3 * HOUR);

const internal = (more: Partial<InternalRecord> = {}): InternalRecord => ({
  transactionId: "tx_1",
  accountId: "acct_1",
  type: "CARD_PURCHASE",
  status: "SETTLED",
  amountCents: 6500,
  providerObjectId: "card_payment_1",
  providerRefs: ["auth_1", "settlement_1"],
  createdAt: old,
  updatedAt: old,
  ...more,
});
const external = (more: Partial<ExternalRecord> = {}): ExternalRecord => ({
  type: "CARD_PURCHASE",
  id: "card_payment_1",
  ref: "settlement_1",
  status: "SETTLED",
  amountCents: 6500,
  currency: "USD",
  transactionId: null,
  createdAt: old,
  updatedAt: old,
  ...more,
});
const statuses = (results: ReturnType<typeof classify>) => results.map((r) => [r.status, r.reason]);

describe("classify", () => {
  it("matches on provider object id, amount, status and the element ref", () => {
    const [result] = classify([internal()], [external()], options);
    expect(result).toMatchObject({ status: "MATCHED", reason: null, type: "CARD_PURCHASE" });
    expect(result.internal?.transactionId).toBe("tx_1");
    expect(result.external?.id).toBe("card_payment_1");
  });

  it("flags a settled amount that differs (the $65 vs $80 demo)", () => {
    expect(statuses(classify([internal()], [external({ amountCents: 8000 })], options))).toEqual([["AMOUNT_MISMATCH", "amount"]]);
  });

  it("flags an amount mismatch even inside the grace window (both sides are final)", () => {
    const now = ago(60_000);
    const results = classify([internal({ updatedAt: now })], [external({ amountCents: 8000, updatedAt: now })], options);
    expect(statuses(results)).toEqual([["AMOUNT_MISMATCH", "amount"]]);
  });

  it("flags a currency the provider reports in other than USD", () => {
    expect(statuses(classify([internal()], [external({ currency: "EUR" })], options))).toEqual([["AMOUNT_MISMATCH", "currency"]]);
  });

  it("flags a status mismatch after the grace window", () => {
    const results = classify([internal({ status: "AUTHORIZED", amountCents: 8000 })], [external({ amountCents: 8000 })], options);
    expect(statuses(results)).toEqual([["STATUS_MISMATCH", "status"]]);
  });

  it("calls a status difference pending while either side changed within the grace window", () => {
    const fresh = external({ updatedAt: ago(10 * 60_000) });
    expect(statuses(classify([internal({ status: "AUTHORIZED" })], [fresh], options))).toEqual([["PENDING_EXTERNAL", "within_grace"]]);
    const ours = internal({ status: "AUTHORIZED", updatedAt: ago(10 * 60_000) });
    expect(statuses(classify([ours], [external()], options))).toEqual([["PENDING_EXTERNAL", "within_grace"]]);
  });

  it("flags a provider element that isn't on our trace", () => {
    const results = classify([internal()], [external({ ref: "settlement_other" })], options);
    expect(statuses(results)).toEqual([["STATUS_MISMATCH", "reference"]]);
  });

  it("reports ours missing at the provider after the grace window, pending within it", () => {
    expect(statuses(classify([internal()], [], options))).toEqual([["MISSING_EXTERNAL", null]]);
    expect(statuses(classify([internal({ updatedAt: ago(5 * 60_000) })], [], options))).toEqual([["PENDING_EXTERNAL", "within_grace"]]);
  });

  it("matches a failed transaction the provider never had", () => {
    const failed = internal({ type: "OUTBOUND_PAYMENT", status: "FAILED", providerObjectId: null, providerRefs: [] });
    expect(statuses(classify([failed], [], options))).toEqual([["MATCHED", "nothing_at_provider"]]);
  });

  it("reports a provider record we don't have after the grace window, pending within it", () => {
    expect(statuses(classify([], [external()], options))).toEqual([["MISSING_INTERNAL", null]]);
    expect(statuses(classify([], [external({ updatedAt: ago(5 * 60_000) })], options))).toEqual([["PENDING_EXTERNAL", "within_grace"]]);
  });

  it("ignores unpaired records created outside the window", () => {
    const before = ago(30 * HOUR);
    expect(classify([internal({ createdAt: before })], [external({ id: "other", createdAt: before })], options)).toEqual([]);
  });

  it("keeps a pair when either side is in the window", () => {
    const results = classify([internal({ createdAt: ago(25 * HOUR) })], [external()], options);
    expect(statuses(results)).toEqual([["MATCHED", null]]);
  });

  it("pairs a transaction without a provider id through the id the provider record names", () => {
    const ours = internal({ type: "FUNDING", providerObjectId: null, providerRefs: ["ch_1"], amountCents: 50000 });
    const theirs = external({ type: "FUNDING", id: "pi_1", ref: "ch_1", amountCents: 50000, transactionId: "tx_1" });
    expect(statuses(classify([ours], [theirs], options))).toEqual([["MATCHED", null]]);
  });

  it("does not pair across types", () => {
    const theirs = external({ type: "FUNDING", id: "pi_1", transactionId: "tx_1" });
    expect(statuses(classify([internal()], [theirs], options))).toEqual([
      ["MISSING_INTERNAL", null],
      ["MISSING_EXTERNAL", null],
    ]);
  });

  it("compares the record ours tracks and flags a second provider record naming the same transaction", () => {
    const ours = internal({ type: "FUNDING", providerObjectId: "pi_2", providerRefs: ["ch_2"], amountCents: 50000 });
    const first = external({ type: "FUNDING", id: "pi_1", ref: "ch_1", amountCents: 50000, transactionId: "tx_1", createdAt: ago(5 * HOUR) });
    const second = external({ type: "FUNDING", id: "pi_2", ref: "ch_2", amountCents: 50000, transactionId: "tx_1" });
    const results = classify([ours], [first, second], options);
    expect(results.map((r) => [r.status, r.external?.id])).toEqual([
      ["MATCHED", "pi_2"],
      ["DUPLICATE", "pi_1"],
    ]);
  });

  it("flags a second settlement on one card payment as a duplicate", () => {
    const results = classify([internal()], [external(), external({ ref: "settlement_2", createdAt: ago(2 * HOUR) })], options);
    expect(results.map((r) => [r.status, r.external?.ref])).toEqual([
      ["MATCHED", "settlement_1"],
      ["DUPLICATE", "settlement_2"],
    ]);
  });

  it("treats the same element listed twice as one record", () => {
    expect(statuses(classify([internal()], [external(), external()], options))).toEqual([["MATCHED", null]]);
  });

  it("matches partial refunds one by one", () => {
    const refund = (id: string, cents: number) => ({ type: "CARD_REVERSAL" as const, id, ref: id, amountCents: cents });
    const ours = [
      internal({ transactionId: "tx_r1", ...refund("refund_1", 1000), providerObjectId: "refund_1", providerRefs: ["refund_1"] }),
      internal({ transactionId: "tx_r2", ...refund("refund_2", 2000), providerObjectId: "refund_2", providerRefs: ["refund_2"] }),
    ];
    const theirs = [external(refund("refund_1", 1000)), external(refund("refund_2", 2500)), external(refund("refund_3", 500))];
    const results = classify(ours, theirs, options);
    expect(results.map((r) => [r.status, r.external?.id ?? r.internal?.transactionId])).toEqual([
      ["MISSING_INTERNAL", "refund_3"],
      ["MATCHED", "refund_1"],
      ["AMOUNT_MISMATCH", "refund_2"],
    ]);
  });

  it("counts every status", () => {
    const counts = countByStatus(classify([internal()], [external({ amountCents: 1 })], options));
    expect(counts).toEqual({
      MATCHED: 0,
      AMOUNT_MISMATCH: 1,
      STATUS_MISMATCH: 0,
      MISSING_INTERNAL: 0,
      MISSING_EXTERNAL: 0,
      DUPLICATE: 0,
      PENDING_EXTERNAL: 0,
    });
  });
});

describe("internalAmountCents", () => {
  it("is the transaction amount until posted, then the posted net (with adjustments)", () => {
    expect(internalAmountCents(8000, null)).toBe(8000);
    expect(internalAmountCents(8000, -6500)).toBe(6500);
    expect(internalAmountCents(8000, -6500 - 1500)).toBe(8000);
    expect(internalAmountCents(50000, 50000)).toBe(50000);
  });
});

describe("fundingRecord", () => {
  const payment = {
    id: "pi_1",
    status: "SUCCEEDED" as const,
    amountCents: 50000,
    amountReceivedCents: 50000,
    currency: "USD",
    chargeId: "ch_1",
    metadata: { transactionId: "tx_1" },
    createdAt: old,
  };

  it("maps a succeeded PaymentIntent to SETTLED for the amount received, ref = charge", () => {
    expect(fundingRecord({ ...payment, amountReceivedCents: 49000 })).toMatchObject({
      type: "FUNDING",
      id: "pi_1",
      ref: "ch_1",
      status: "SETTLED",
      amountCents: 49000,
      transactionId: "tx_1",
    });
  });

  it("maps pending and failed PaymentIntents without a ref", () => {
    expect(fundingRecord({ ...payment, status: "PENDING", amountReceivedCents: 0 })).toMatchObject({ status: "PENDING", ref: null, amountCents: 50000 });
    expect(fundingRecord({ ...payment, status: "FAILED", amountReceivedCents: 0 })).toMatchObject({ status: "FAILED", ref: null });
  });
});

describe("cardPaymentRecords", () => {
  const auth: CardPaymentElement = { kind: "AUTHORIZATION", id: "auth_1", amountCents: 8000, merchant: null, expiresAt: null };
  const card = (...elements: CardPaymentElement[]) => cardPaymentRecords({ id: "cp_1", elements, createdAt: old, updatedAt: old });
  const brief = (records: ExternalRecord[]) => records.map((r) => [r.type, r.id, r.ref, r.status, r.amountCents]);

  it("an open authorization is AUTHORIZED for what is still authorized", () => {
    expect(brief(card(auth))).toEqual([["CARD_PURCHASE", "cp_1", "auth_1", "AUTHORIZED", 8000]]);
    expect(brief(card(auth, { kind: "REVERSAL", id: "rev_1", amountCents: 3000, remainingAuthorizationCents: 5000 }))).toEqual([
      ["CARD_PURCHASE", "cp_1", "auth_1", "AUTHORIZED", 5000],
    ]);
  });

  it("a settlement is SETTLED for the settled amount", () => {
    expect(brief(card(auth, { kind: "SETTLEMENT", id: "set_1", amountCents: 6500 }))).toEqual([["CARD_PURCHASE", "cp_1", "set_1", "SETTLED", 6500]]);
  });

  it("each settlement is its own record, so a second one is a duplicate", () => {
    const records = card(auth, { kind: "SETTLEMENT", id: "set_1", amountCents: 6500 }, { kind: "SETTLEMENT", id: "set_2", amountCents: 1500 });
    expect(brief(records)).toEqual([
      ["CARD_PURCHASE", "cp_1", "set_1", "SETTLED", 6500],
      ["CARD_PURCHASE", "cp_1", "set_2", "SETTLED", 1500],
    ]);
  });

  it("a full void is REVERSED and an expiry EXPIRED, at the authorized amount; the first wins", () => {
    const voided: CardPaymentElement = { kind: "REVERSAL", id: "rev_1", amountCents: 8000, remainingAuthorizationCents: 0 };
    const expired: CardPaymentElement = { kind: "EXPIRATION", id: "exp_1", amountCents: 8000 };
    expect(brief(card(auth, voided))).toEqual([["CARD_PURCHASE", "cp_1", "rev_1", "REVERSED", 8000]]);
    expect(brief(card(auth, expired, voided))).toEqual([["CARD_PURCHASE", "cp_1", "exp_1", "EXPIRED", 8000]]);
  });

  it("a late settlement after an expiry is SETTLED", () => {
    const records = card(auth, { kind: "EXPIRATION", id: "exp_1", amountCents: 8000 }, { kind: "SETTLEMENT", id: "set_1", amountCents: 8000 });
    expect(brief(records)).toEqual([["CARD_PURCHASE", "cp_1", "set_1", "SETTLED", 8000]]);
  });

  it("refunds are CARD_REVERSAL records keyed by the refund element, partial refunds separately", () => {
    const records = card(
      auth,
      { kind: "SETTLEMENT", id: "set_1", amountCents: 8000 },
      { kind: "REFUND", id: "ref_1", amountCents: 1000, merchant: null },
      { kind: "REFUND", id: "ref_2", amountCents: 2000, merchant: null },
    );
    expect(brief(records)).toEqual([
      ["CARD_PURCHASE", "cp_1", "set_1", "SETTLED", 8000],
      ["CARD_REVERSAL", "ref_1", "ref_1", "SETTLED", 1000],
      ["CARD_REVERSAL", "ref_2", "ref_2", "SETTLED", 2000],
    ]);
  });

  it("a refund on its own card payment yields only the refund", () => {
    expect(brief(card({ kind: "REFUND", id: "ref_1", amountCents: 1000, merchant: null }))).toEqual([["CARD_REVERSAL", "ref_1", "ref_1", "SETTLED", 1000]]);
  });

  it("a declined attempt yields nothing", () => {
    expect(card({ kind: "NO_EFFECT", id: "dec_1", category: "card_decline" })).toEqual([]);
  });

  it("an element we don't model makes the purchase UNSUPPORTED", () => {
    const records = card(auth, { kind: "UNSUPPORTED", id: "inc_1", category: "card_increment", reason: "not modelled" });
    expect(brief(records)).toEqual([["CARD_PURCHASE", "cp_1", "inc_1", "UNSUPPORTED", 8000]]);
  });
});

describe("transferRecords", () => {
  const accepted: TransferSnapshot = { submittedToNetwork: false, settled: false, returned: null, rejected: false };
  const transfer = (snapshot: TransferSnapshot) => ({ id: "ach_1", amountCents: 10000, currency: "USD", snapshot, createdAt: old, updatedAt: old });
  const brief = (records: ExternalRecord[]) => records.map((r) => [r.type, r.ref, r.status, r.transactionId]);

  it("maps each transfer state onto the payment status", () => {
    expect(brief(transferRecords(transfer(accepted), "tx_1"))).toEqual([["OUTBOUND_PAYMENT", "ach_1", "SUBMITTED", "tx_1"]]);
    expect(brief(transferRecords(transfer({ ...accepted, submittedToNetwork: true, settled: true }), null))).toEqual([["OUTBOUND_PAYMENT", "ach_1", "COMPLETED", null]]);
    expect(brief(transferRecords(transfer({ ...accepted, rejected: true }), null))).toEqual([["OUTBOUND_PAYMENT", null, "FAILED", null]]);
    expect(brief(transferRecords(transfer({ ...accepted, returned: { id: "ret_1", reason: null } }), null))).toEqual([["OUTBOUND_PAYMENT", "ret_1", "RETURNED", null]]);
  });

  it("a return after settlement is a PAYMENT_RETURN record on the same transfer", () => {
    const records = transferRecords(transfer({ ...accepted, settled: true, returned: { id: "ret_1", reason: null } }), "tx_1");
    expect(brief(records)).toEqual([
      ["OUTBOUND_PAYMENT", "ach_1", "COMPLETED", "tx_1"],
      ["PAYMENT_RETURN", "ret_1", "COMPLETED", null],
    ]);
    expect(records[1].id).toBe("ach_1");
  });
});

describe("suggestedAdjustmentCents", () => {
  it("debits more when a debit settled higher at the provider, credits more for a credit", () => {
    expect(suggestedAdjustmentCents("CARD_PURCHASE", 1500)).toBe(-1500);
    expect(suggestedAdjustmentCents("OUTBOUND_PAYMENT", -200)).toBe(200);
    expect(suggestedAdjustmentCents("FUNDING", -1000)).toBe(-1000);
    expect(suggestedAdjustmentCents("CARD_REVERSAL", 500)).toBe(500);
    expect(suggestedAdjustmentCents("FUNDING", 0)).toBeNull();
    expect(suggestedAdjustmentCents("FUNDING", null)).toBeNull();
  });
});
