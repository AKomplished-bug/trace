import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyKeyReusedError,
  isPaymentProviderError,
  isProviderRejectedError,
  isWebhookVerificationError,
  PaymentProviderError,
  ProviderRejectedError,
  WebhookVerificationError,
} from "./payment-provider";

describe("provider error checks", () => {
  it("recognise each class and its subclasses, including from another copy of the module", async () => {
    vi.resetModules();
    const copy = await import("./payment-provider");
    for (const source of [{ PaymentProviderError, ProviderRejectedError, IdempotencyKeyReusedError, WebhookVerificationError }, copy]) {
      const unavailable = new source.PaymentProviderError("timeout", null);
      const rejected = new source.ProviderRejectedError("refused", null, 422);
      const reused = new source.IdempotencyKeyReusedError("reused", null, "transfer_1");
      expect([unavailable, rejected, reused].map(isPaymentProviderError)).toEqual([true, true, true]);
      expect([unavailable, rejected, reused].map(isProviderRejectedError)).toEqual([false, true, true]);
      expect(isWebhookVerificationError(new source.WebhookVerificationError())).toBe(true);
    }
  });

  it("reject other errors and non-errors", () => {
    for (const value of [new Error("boom"), { name: "ProviderRejectedError" }, "WebhookVerificationError", null]) {
      expect(isPaymentProviderError(value)).toBe(false);
      expect(isProviderRejectedError(value)).toBe(false);
      expect(isWebhookVerificationError(value)).toBe(false);
    }
  });
});
