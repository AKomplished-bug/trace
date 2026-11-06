import { createHmac } from "node:crypto";
import authorized from "./fixtures/card_payment.authorized.json";
import expired from "./fixtures/card_payment.expired.json";
import refunded from "./fixtures/card_payment.refunded.json";
import reversed from "./fixtures/card_payment.reversed.json";
import createdEvent from "./fixtures/event.card_payment.created.json";
import { IncreaseAdapter } from ".";

/**
 * Test-only stand-in for the Increase sandbox API behind the real SDK (via its `fetch` option),
 * so tests exercise our real requests — paths, params, timeout, no retries — without calling
 * Increase. Card payments live in `cardPayments`; the simulation endpoints append elements built
 * from the fixtures, the way the sandbox does. Refunds land on the purchase's own card payment.
 */
export const INCREASE_WEBHOOK_SECRET = "increase_test_fixture_secret";

type Json = Record<string, unknown>;
export type CardPaymentJson = Json & { id: string; card_id: string; elements: Json[] };

export interface FakeIncrease {
  adapter: IncreaseAdapter;
  /** Card payments by id; tests may edit or replace them to simulate Increase's view. */
  cardPayments: Map<string, CardPaymentJson>;
  requests: Array<{ method: string; path: string; body: Json }>;
  /**
   * How the next request behaves: succeed, decline (authorizations only), never answer
   * (timeout), or refuse with 409 invalid_operation_error.
   */
  next: "succeed" | "decline" | "hang" | "reject";
}

const template = (fixture: { elements: unknown[] }, index: number) => structuredClone(fixture.elements[index]) as Json;
const detail = (element: Json) => element[element.category as string] as Json;

export function createFakeIncrease({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): FakeIncrease {
  let counter = 0;
  const fake: FakeIncrease = { adapter: undefined as unknown as IncreaseAdapter, cardPayments: new Map(), requests: [], next: "succeed" };

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": `req_fake_${++counter}` } });
  const notFound = () => respond(404, { status: 404, type: "object_not_found_error", title: "Could not find the object." });

  const element = (fixture: { elements: unknown[] }, index: number, prefix: string, fields: Json): Json => {
    const next = template(fixture, index);
    Object.assign(detail(next), { id: `${prefix}_fake_${++counter}`, ...fields });
    next.created_at = new Date().toISOString();
    return next;
  };
  const authorizationOf = (payment: CardPaymentJson): Json | undefined => {
    const auth = payment.elements.find((e) => e.category === "card_authorization");
    return auth && detail(auth);
  };
  const remainingCents = (payment: CardPaymentJson) => {
    const auth = (authorizationOf(payment)?.amount as number | undefined) ?? 0;
    const reversedCents = payment.elements
      .filter((e) => e.category === "card_reversal")
      .reduce((sum, e) => sum + (detail(e).reversal_amount as number), 0);
    return auth - reversedCents;
  };

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Json;
    fake.requests.push({ method, path: url.pathname, body });

    const mode = fake.next;
    fake.next = "succeed";
    if (mode === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (mode === "reject") return respond(409, { status: 409, type: "invalid_operation_error", title: "The operation is not allowed." });

    const retrieve = /^\/card_payments\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && retrieve) {
      const payment = fake.cardPayments.get(retrieve[1]);
      return payment ? respond(200, payment) : notFound();
    }
    if (method !== "POST") return notFound();

    switch (url.pathname) {
      case "/accounts":
        return respond(200, { id: `account_fake_${++counter}`, type: "account", name: body.name });
      case "/account_numbers":
        return respond(200, { id: `account_number_fake_${++counter}`, type: "account_number", account_id: body.account_id });
      case "/simulations/inbound_ach_transfers":
        return respond(200, { id: `inbound_ach_transfer_fake_${++counter}`, type: "inbound_ach_transfer", amount: body.amount, status: "accepted" });
      case "/cards":
        return respond(200, { id: `card_fake_${++counter}`, type: "card", account_id: body.account_id, last4: "4242", status: "active" });
      case "/simulations/card_authorizations": {
        const id = `card_payment_fake_${++counter}`;
        const payment: CardPaymentJson = { ...structuredClone(authorized), id, card_id: String(body.card_id), elements: [] };
        if (mode === "decline") {
          payment.elements.push({ category: "card_decline", created_at: new Date().toISOString(), card_decline: { id: `card_decline_fake_${counter}`, card_payment_id: id } });
          fake.cardPayments.set(id, payment);
          return respond(200, { type: "inbound_card_authorization_simulation_result", pending_transaction: null, declined_transaction: { source: { category: "card_decline", card_decline: { card_payment_id: id } } } });
        }
        const pendingTransactionId = `pending_transaction_fake_${counter}`;
        const fields: Json = { card_payment_id: id, amount: body.amount, presentment_amount: body.amount, pending_transaction_id: pendingTransactionId };
        if (typeof body.merchant_descriptor === "string") fields.merchant_descriptor = body.merchant_descriptor;
        payment.elements.push(element(authorized, 0, "card_authorization", fields));
        fake.cardPayments.set(id, payment);
        return respond(200, {
          type: "inbound_card_authorization_simulation_result",
          pending_transaction: { id: pendingTransactionId, source: { category: "card_authorization", card_authorization: { card_payment_id: id } } },
          declined_transaction: null,
        });
      }
      case "/simulations/card_settlements": {
        const payment = [...fake.cardPayments.values()].find((p) => authorizationOf(p)?.pending_transaction_id === body.pending_transaction_id);
        if (!payment || payment.card_id !== body.card_id) return notFound();
        const transactionId = `transaction_fake_${++counter}`;
        payment.elements.push(element(refunded, 1, "card_settlement", { card_payment_id: payment.id, amount: body.amount, presentment_amount: body.amount, transaction_id: transactionId }));
        return respond(200, { id: transactionId, type: "transaction" });
      }
      case "/simulations/card_reversals": {
        const payment = fake.cardPayments.get(String(body.card_payment_id));
        if (!payment) return notFound();
        const amount = typeof body.amount === "number" ? body.amount : remainingCents(payment);
        payment.elements.push(element(reversed, 1, "card_reversal", { reversal_amount: amount, reversal_presentment_amount: amount, updated_authorization_amount: remainingCents(payment) - amount }));
        return respond(200, payment);
      }
      case "/simulations/card_authorization_expirations": {
        const payment = fake.cardPayments.get(String(body.card_payment_id));
        if (!payment) return notFound();
        payment.elements.push(element(expired, 1, "card_authorization_expiration", { expired_amount: remainingCents(payment) }));
        return respond(200, payment);
      }
      case "/simulations/card_refunds": {
        const payment = [...fake.cardPayments.values()].find((p) => p.elements.some((e) => e.category === "card_settlement" && detail(e).transaction_id === body.transaction_id));
        if (!payment) return notFound();
        const settlement = detail(payment.elements.find((e) => detail(e).transaction_id === body.transaction_id)!);
        const amount = typeof body.amount === "number" ? body.amount : settlement.amount;
        const transactionId = `transaction_fake_${++counter}`;
        payment.elements.push(element(refunded, 2, "card_refund", { card_payment_id: payment.id, amount, presentment_amount: amount, transaction_id: transactionId }));
        return respond(200, { id: transactionId, type: "transaction" });
      }
      default:
        return notFound();
    }
  };

  fake.adapter = new IncreaseAdapter({ apiKey: "increase_test_fake", webhookSecret: INCREASE_WEBHOOK_SECRET, fetch: fakeFetch as typeof fetch, timeoutMs });
  return fake;
}

/** Puts a card payment (e.g. a fixture) into the fake so the worker's re-fetch finds it. */
export function seedCardPayment(fake: FakeIncrease, payment: CardPaymentJson): CardPaymentJson {
  fake.cardPayments.set(payment.id, structuredClone(payment));
  return payment;
}

/** A thin Increase event for a card payment, as Increase sends it. */
export function cardPaymentEvent(cardPaymentId: string, category = "card_payment.updated", id = `event_fake_${crypto.randomUUID()}`) {
  return { ...structuredClone(createdEvent), id, category, associated_object_id: cardPaymentId };
}

/** Signs `payload` the way Increase does (Standard Webhooks), for the webhook route. */
export function signedIncreaseWebhook(
  payload: { id: string },
  { secret = INCREASE_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) }: { secret?: string; timestamp?: number } = {},
): { body: string; headers: Headers } {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${payload.id}.${timestamp}.${body}`).digest("base64");
  return {
    body,
    headers: new Headers({ "webhook-id": payload.id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}`, "content-type": "application/json" }),
  };
}
