import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eventDeliveries, externalEvents } from "../../../db/schema";
import { createTestDb, resetDb } from "../../../db/test-helpers";
import { createFakeStripe, signedWebhook } from "../../../integrations/stripe/fake-stripe";
import paymentSucceeded from "../../../integrations/stripe/fixtures/event.payment_intent.succeeded.json";
import { logger } from "../../../lib/logger";
import { handleWebhook } from "./handle-webhook";

const { pool, db } = createTestDb(20);
const { adapter } = createFakeStripe();
const deps = { db, webhookVerifiers: { stripe: adapter }, logger };

function deliver(body: string, signature: string, provider = "stripe") {
  const request = new Request(`http://localhost/api/webhooks/${provider}`, {
    method: "POST",
    body,
    headers: { "stripe-signature": signature, "content-type": "application/json" },
  });
  return handleWebhook(deps, provider, request);
}

beforeEach(() => resetDb(db));
afterAll(() => pool.end());

describe("POST /api/webhooks/:provider", () => {
  it("stores a verified event as RECEIVED and due now, with one delivery", async () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    const response = await deliver(body, signature);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const [event] = await db.select().from(externalEvents);
    expect(event).toMatchObject({
      provider: "stripe",
      externalEventId: paymentSucceeded.id,
      eventType: "payment_intent.succeeded",
      status: "RECEIVED",
      attempts: 0,
      payload: paymentSucceeded,
    });
    expect(event.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    const deliveries = await db.select().from(eventDeliveries);
    expect(deliveries).toMatchObject([{ externalEventId: event.id, isDuplicate: false, correlationId: event.correlationId }]);
  });

  it("records a duplicate delivery without touching the stored event", async () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    await deliver(body, signature);
    await db.update(externalEvents).set({ status: "PROCESSED" });
    expect((await deliver(body, signature)).status).toBe(200);

    const events = await db.select().from(externalEvents);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("PROCESSED");
    const deliveries = await db.select().from(eventDeliveries).orderBy(asc(eventDeliveries.receivedAt));
    expect(deliveries.map((d) => d.isDuplicate)).toEqual([false, true]);
  });

  it("stores one event when the same delivery races itself", async () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    const responses = await Promise.all(Array.from({ length: 8 }, () => deliver(body, signature)));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    const [event] = await db.select().from(externalEvents);
    const deliveries = await db.select().from(eventDeliveries).where(eq(eventDeliveries.externalEventId, event.id));
    expect(await db.$count(externalEvents)).toBe(1);
    expect(deliveries.filter((d) => !d.isDuplicate)).toHaveLength(1);
    expect(deliveries).toHaveLength(8);
  });

  it("rejects a bad signature with a generic 400 and stores nothing", async () => {
    const { body } = signedWebhook(paymentSucceeded);
    const forged = signedWebhook(paymentSucceeded, "whsec_attacker").signature;
    const response = await deliver(body, forged);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_signature", message: "Webhook signature verification failed" },
    });
    expect(await db.$count(externalEvents)).toBe(0);
    expect(await db.$count(eventDeliveries)).toBe(0);
  });

  it("returns 404 for an unknown provider", async () => {
    const { body, signature } = signedWebhook(paymentSucceeded);
    for (const provider of ["paypal", "toString", "__proto__"]) {
      expect((await deliver(body, signature, provider)).status).toBe(404);
    }
    expect(await db.$count(externalEvents)).toBe(0);
  });
});
