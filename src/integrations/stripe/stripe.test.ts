import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { PaymentProviderError, WebhookVerificationError } from "../payment-provider";
import { createFakeStripe, signedWebhook, WEBHOOK_SECRET } from "./fake-stripe";
import chargeSucceeded from "./fixtures/event.charge.succeeded.json";
import paymentFailed from "./fixtures/event.payment_intent.payment_failed.json";
import paymentSucceeded from "./fixtures/event.payment_intent.succeeded.json";
import succeededIntent from "./fixtures/payment_intent.succeeded.json";
import { paymentIntentIdFromEvent, StripeAdapter, toProviderPayment } from ".";

// No httpClient: any API call would go to real Stripe, so this one is only used for signatures.
const adapter = new StripeAdapter({ secretKey: "sk_test_unused", webhookSecret: WEBHOOK_SECRET });

function headers(signature?: string) {
  return new Headers(signature ? { "stripe-signature": signature } : {});
}

describe("verifyWebhook", () => {
  it("accepts a correctly signed event and returns its id, type and payload", () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    expect(adapter.verifyWebhook(body, headers(signature))).toEqual({
      externalEventId: paymentSucceeded.id,
      eventType: "payment_intent.succeeded",
      payload: paymentSucceeded,
    });
  });

  it("rejects a missing, wrong-secret, tampered or stale signature", () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    const wrongSecret = signedWebhook(paymentSucceeded, "whsec_other").signature;
    const stale = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    for (const [raw, sig] of [
      [body, undefined],
      [body, wrongSecret],
      [body.replace("50000", "90000"), signature],
      [body, stale],
      [body, "garbage"],
    ] as const) {
      expect(() => adapter.verifyWebhook(raw, headers(sig))).toThrow(WebhookVerificationError);
    }
  });
});

describe("mapping fixtures", () => {
  it("maps a succeeded PaymentIntent", () => {
    expect(toProviderPayment(paymentSucceeded.data.object as unknown as Stripe.PaymentIntent, "req_1")).toEqual({
      id: "pi_3TfuNd2eZvKYlo2C0kq7f9Xa",
      status: "SUCCEEDED",
      amountCents: 50000,
      amountReceivedCents: 50000,
      currency: "USD",
      chargeId: "ch_3TfuNd2eZvKYlo2C0Q1b7mWd",
      metadata: { transactionId: "fixture" },
      requestId: "req_1",
    });
  });

  it("maps a declined PaymentIntent to FAILED", () => {
    const payment = toProviderPayment(paymentFailed.data.object as unknown as Stripe.PaymentIntent, null);
    expect(payment).toMatchObject({ status: "FAILED", amountReceivedCents: 0, chargeId: "ch_3TfuPq2eZvKYlo2C1yH2n0Vb" });
  });

  it("reads the PaymentIntent id from payment_intent events only", () => {
    expect(paymentIntentIdFromEvent(paymentSucceeded)).toBe("pi_3TfuNd2eZvKYlo2C0kq7f9Xa");
    expect(() => paymentIntentIdFromEvent(chargeSucceeded)).toThrow();
  });
});

describe("Stripe API calls (fake Stripe behind the real SDK)", () => {
  it("creates and confirms a PaymentIntent with our idempotency key and pm_card_visa", async () => {
    const fake = createFakeStripe();
    const payment = await fake.adapter.createFundingPayment({
      amountCents: 50000,
      idempotencyKey: "funding-tx-1",
      metadata: { transaction_id: "tx-1" },
    });
    expect(payment).toMatchObject({ status: "SUCCEEDED", amountCents: 50000, currency: "USD" });
    expect(payment.requestId).toMatch(/^req_fake_/);
    const [request] = fake.requests;
    expect(request.idempotencyKey).toBe("funding-tx-1");
    expect(Object.fromEntries(request.body)).toMatchObject({
      amount: "50000",
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: "true",
      "metadata[transaction_id]": "tx-1",
    });
    expect(await fake.adapter.retrievePaymentIntent(payment.id)).toMatchObject({ id: payment.id, status: "SUCCEEDED" });
  });

  it("returns a declined payment as FAILED instead of throwing", async () => {
    const fake = createFakeStripe();
    fake.nextCreate = "decline";
    const payment = await fake.adapter.createFundingPayment({ amountCents: 100, idempotencyKey: "k", metadata: {} });
    expect(payment).toMatchObject({ status: "FAILED", amountReceivedCents: 0 });
    expect(payment.id).toMatch(/^pi_fake_/);
  });

  it("times out once, without SDK retries, as a PaymentProviderError", async () => {
    const fake = createFakeStripe({ timeoutMs: 50 });
    fake.nextCreate = "hang";
    const call = fake.adapter.createFundingPayment({ amountCents: 100, idempotencyKey: "k", metadata: {} });
    await expect(call).rejects.toThrow(PaymentProviderError);
    await expect(call).rejects.toThrow("StripeConnectionError");
    expect(fake.requests).toHaveLength(1);
  });

  it("reports a missing PaymentIntent as PaymentProviderError", async () => {
    const fake = createFakeStripe();
    const call = fake.adapter.retrievePaymentIntent("pi_missing");
    await expect(call).rejects.toThrow(PaymentProviderError);
    await expect(call).rejects.toThrow("resource_missing");
  });
});

describe("listPayments (reconciliation)", () => {
  const window = { start: new Date("2026-11-07T00:00:00Z"), end: new Date("2026-11-08T00:00:00Z") };
  const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

  it("lists every PaymentIntent created in the window, across pages, with each page's request id", async () => {
    const fake = createFakeStripe();
    for (let i = 0; i < 150; i++) {
      fake.intents.set(`pi_${i}`, { ...structuredClone(succeededIntent), id: `pi_${i}`, created: seconds(window.start) + i * 60 });
    }
    fake.intents.set("pi_before", { ...structuredClone(succeededIntent), id: "pi_before", created: seconds(window.start) - 1 });
    fake.intents.set("pi_at_end", { ...structuredClone(succeededIntent), id: "pi_at_end", created: seconds(window.end) });

    const { items, requestIds } = await fake.adapter.listPayments(window);
    expect(items).toHaveLength(150);
    expect(new Set(items.map((p) => p.id)).size).toBe(150);
    expect(items.some((p) => p.id === "pi_before" || p.id === "pi_at_end")).toBe(false);
    expect(requestIds).toHaveLength(2);
    expect(items.find((p) => p.id === "pi_0")).toMatchObject({ status: "SUCCEEDED", createdAt: window.start, currency: "USD" });
    expect(fake.requests.every((r) => r.method === "GET" && r.path === "/v1/payment_intents")).toBe(true);
  });

  it("stops once the deadline passes", async () => {
    const fake = createFakeStripe();
    await expect(fake.adapter.listPayments(window, AbortSignal.abort())).rejects.toThrow(PaymentProviderError);
    expect(fake.requests).toHaveLength(0);
  });
});
