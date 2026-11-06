import { describe, expect, it } from "vitest";
import {
  accountNumberLast4,
  isValidRoutingNumber,
  nextPaymentStatus,
  planPaymentActions,
  type AppliedPaymentState,
  type TransferSnapshot,
} from ".";

const accepted: TransferSnapshot = { submittedToNetwork: false, settled: false, returned: null, rejected: false };
const submitted: TransferSnapshot = { ...accepted, submittedToNetwork: true };
const settled: TransferSnapshot = { ...submitted, settled: true };
const returnedEarly: TransferSnapshot = { ...submitted, returned: { id: "ret_1", reason: "no_account" } };
const returnedLate: TransferSnapshot = { ...settled, returned: { id: "ret_1", reason: "no_account" } };

const state = (status: AppliedPaymentState["status"], more: Partial<AppliedPaymentState> = {}): AppliedPaymentState => ({
  status,
  networkSubmissionRecorded: false,
  returnRecorded: false,
  ...more,
});
const kinds = (result: ReturnType<typeof planPaymentActions>) => ("actions" in result ? result.actions.map((a) => a.kind) : result);

describe("payment transitions", () => {
  it.each([
    ["PENDING", "SUBMIT", "SUBMITTED"],
    ["PENDING", "FAIL", "FAILED"],
    ["SUBMITTED", "SETTLE", "COMPLETED"],
    ["SUBMITTED", "RETURN", "RETURNED"],
    ["SUBMITTED", "FAIL", "FAILED"],
  ] as const)("%s --%s--> %s", (from, event, to) => {
    expect(nextPaymentStatus(from, event)).toBe(to);
  });

  it.each([
    ["PENDING", "SETTLE"],
    ["PENDING", "RETURN"],
    ["SUBMITTED", "SUBMIT"],
    ["COMPLETED", "RETURN"],
    ["COMPLETED", "FAIL"],
    ["RETURNED", "SETTLE"],
    ["FAILED", "SUBMIT"],
    ["SETTLED", "SETTLE"],
  ] as const)("refuses %s --%s-->", (from, event) => {
    expect(nextPaymentStatus(from, event)).toBeNull();
  });
});

describe("routing numbers and masking", () => {
  it.each(["101050001", "021000021", "011000015"])("accepts %s (valid ABA checksum)", (routing) => {
    expect(isValidRoutingNumber(routing)).toBe(true);
  });

  it.each(["101050002", "12345678", "1234567890", "10105000a", " 01050001", ""])("rejects %j", (routing) => {
    expect(isValidRoutingNumber(routing)).toBe(false);
  });

  it("keeps only the last four digits of an account number", () => {
    expect(accountNumberLast4("987654321")).toBe("4321");
  });
});

describe("planning payment steps from a transfer snapshot", () => {
  it("walks the happy path one snapshot at a time", () => {
    expect(kinds(planPaymentActions(state("SUBMITTED"), accepted))).toEqual([]);
    expect(kinds(planPaymentActions(state("SUBMITTED"), submitted))).toEqual(["NETWORK_SUBMITTED"]);
    expect(kinds(planPaymentActions(state("SUBMITTED", { networkSubmissionRecorded: true }), settled))).toEqual(["COMPLETE"]);
    expect(kinds(planPaymentActions(state("COMPLETED", { networkSubmissionRecorded: true }), settled))).toEqual([]);
  });

  it("accepts a PENDING payment first when the transfer exists before we stored its id, then applies the rest", () => {
    expect(kinds(planPaymentActions(state("PENDING"), accepted))).toEqual(["ACCEPT"]);
    expect(kinds(planPaymentActions(state("PENDING"), settled))).toEqual(["ACCEPT", "NETWORK_SUBMITTED", "COMPLETE"]);
  });

  it("a return before settlement releases; after settlement it is a new return, once", () => {
    expect(planPaymentActions(state("SUBMITTED", { networkSubmissionRecorded: true }), returnedEarly)).toEqual({
      actions: [{ kind: "RETURN_BEFORE_COMPLETION", returnId: "ret_1", reason: "no_account" }],
    });
    expect(kinds(planPaymentActions(state("COMPLETED", { networkSubmissionRecorded: true }), returnedLate))).toEqual(["RETURN_AFTER_COMPLETION"]);
    expect(kinds(planPaymentActions(state("SUBMITTED"), returnedLate))).toEqual(["NETWORK_SUBMITTED", "COMPLETE", "RETURN_AFTER_COMPLETION"]);
    expect(kinds(planPaymentActions(state("COMPLETED", { returnRecorded: true }), returnedLate))).toEqual([]);
    expect(kinds(planPaymentActions(state("RETURNED"), returnedEarly))).toEqual([]);
  });

  it("an older snapshot than what we applied has no effect", () => {
    expect(kinds(planPaymentActions(state("COMPLETED", { networkSubmissionRecorded: true }), accepted))).toEqual([]);
    expect(kinds(planPaymentActions(state("RETURNED"), submitted))).toEqual([]);
  });

  it("a rejection fails a submitted payment; repeating it does nothing", () => {
    const rejected = { ...accepted, rejected: true };
    expect(kinds(planPaymentActions(state("SUBMITTED"), rejected))).toEqual(["REJECT"]);
    expect(kinds(planPaymentActions(state("PENDING"), rejected))).toEqual(["ACCEPT", "REJECT"]);
    expect(kinds(planPaymentActions(state("FAILED"), rejected))).toEqual([]);
  });

  it("a live transfer for a FAILED payment, or a rejection of a completed one, is a conflict for Ops", () => {
    expect(planPaymentActions(state("FAILED"), submitted)).toEqual({ conflict: "the payment is FAILED but the provider has a live transfer for it" });
    expect(planPaymentActions(state("COMPLETED"), { ...settled, rejected: true })).toEqual({ conflict: "the provider rejected a transfer we have as COMPLETED" });
  });
});
