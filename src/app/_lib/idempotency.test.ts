import { describe, expect, it } from "vitest";
import { keyFor, ownerErrorMessage, UNCONFIRMED_MESSAGE, UNREACHABLE_MESSAGE } from "./idempotency";

const keys = () => {
  let n = 0;
  return () => `key-${++n}`;
};

describe("keyFor", () => {
  it("reuses the key while the body is identical, so a retry replays", () => {
    const next = keys();
    const first = keyFor(null, { amountCents: 50000 }, next);
    expect(first.key).toBe("key-1");
    expect(keyFor(first, { amountCents: 50000 }, next)).toBe(first);
  });

  it("uses a new key once the body changes, so an edited request isn't a 409", () => {
    const next = keys();
    const first = keyFor(null, { amountCents: 50000 }, next);
    const edited = keyFor(first, { amountCents: 60000 }, next);
    expect(edited.key).toBe("key-2");
    expect(keyFor(edited, { amountCents: 50000 }, next).key).toBe("key-3");
  });

  it("starts fresh after a success (previous forgotten), even for the same body", () => {
    const next = keys();
    keyFor(null, { amountCents: 50000 }, next);
    expect(keyFor(null, { amountCents: 50000 }, next).key).toBe("key-2");
  });
});

describe("ownerErrorMessage", () => {
  it("points the owner at Activity when the outcome is unknown, never at headers", () => {
    const provider = { status: 502, code: "provider_unavailable", message: "… Retry with the same Idempotency-Key." };
    expect(ownerErrorMessage(provider)).toBe(UNCONFIRMED_MESSAGE);
    expect(ownerErrorMessage({ status: 500, code: "internal_error", message: "retry with the same Idempotency-Key" })).toBe(UNCONFIRMED_MESSAGE);
    expect(ownerErrorMessage({ status: 409, code: "idempotency_conflict", message: "This Idempotency-Key was already used" })).toBe(UNCONFIRMED_MESSAGE);
    expect(ownerErrorMessage({ status: null, code: null, message: "" })).toBe(UNREACHABLE_MESSAGE);
    for (const status of [409, 500, 502]) expect(ownerErrorMessage({ status, code: null, message: "x" })).not.toMatch(/Idempotency/);
  });

  it("passes owner-ready messages through and hides setup instructions", () => {
    const funds = "Available balance is $10.00; this payment needs $20.00. Nothing was sent.";
    expect(ownerErrorMessage({ status: 422, code: "insufficient_funds", message: funds })).toBe(funds);
    expect(ownerErrorMessage({ status: 409, code: "account_not_linked", message: "run npm run increase:bootstrap" })).not.toMatch(/npm/);
  });
});
