import { createHmac } from "node:crypto";
import achTransferPending from "./fixtures/ach_transfer.pending_submission.json";
import authorized from "./fixtures/card_payment.authorized.json";
import expired from "./fixtures/card_payment.expired.json";
import refunded from "./fixtures/card_payment.refunded.json";
import reversed from "./fixtures/card_payment.reversed.json";
import achCreatedEvent from "./fixtures/event.ach_transfer.created.json";
import createdEvent from "./fixtures/event.card_payment.created.json";
import { IncreaseAdapter } from ".";

/**
 * Test-only stand-in for the Increase sandbox API behind the real SDK (via its `fetch` option),
 * so tests exercise our real requests — paths, params, timeout, no retries — without calling
 * Increase. Card payments live in `cardPayments`; the simulation endpoints append elements built
 * from the fixtures, the way the sandbox does. Refunds land on the purchase's own card payment.
 * ACH transfers live in `achTransfers`; creation honours `Idempotency-Key` like Increase (same key
 * and body → the first transfer; different body → 409 idempotency_key_already_used_error).
 */
export const INCREASE_WEBHOOK_SECRET = "increase_test_fixture_secret";

type Json = Record<string, unknown>;
export type CardPaymentJson = Json & { id: string; card_id: string; elements: Json[] };
export type AchTransferJson = Json & { id: string; status: string; amount: number; idempotency_key: string | null };

export interface FakeIncrease {
  adapter: IncreaseAdapter;
  /** Card payments by id; tests may edit or replace them to simulate Increase's view. */
  cardPayments: Map<string, CardPaymentJson>;
  /** ACH transfers by id; tests may edit them to simulate Increase's view. */
  achTransfers: Map<string, AchTransferJson>;
  requests: Array<{ method: string; path: string; body: Json; idempotencyKey?: string | null }>;
  /**
   * How the next request behaves: succeed, decline (authorizations only), never answer
   * (timeout), refuse with 409 invalid_operation_error, refuse with 400 invalid_parameters_error,
   * fail with 500, or do the work and then never answer (the response is lost: Increase created
   * the object but we time out).
   */
  next: "succeed" | "decline" | "hang" | "reject" | "invalid" | "error" | "succeed_then_hang";
}

const template = (fixture: { elements: unknown[] }, index: number) => structuredClone(fixture.elements[index]) as Json;
const detail = (element: Json) => element[element.category as string] as Json;

export function createFakeIncrease({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): FakeIncrease {
  let counter = 0;
  const fake: FakeIncrease = { adapter: undefined as unknown as IncreaseAdapter, cardPayments: new Map(), achTransfers: new Map(), requests: [], next: "succeed" };
  // Idempotency-Key → the request body it was first used with and the transfer it created.
  const achKeys = new Map<string, { body: string; id: string }>();

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
    const idempotencyKey = new Headers(init?.headers).get("idempotency-key");
    // The SDK sends an auto-generated key on every POST; only ACH creates carry ours, so only they record it.
    fake.requests.push(url.pathname === "/ach_transfers" ? { method, path: url.pathname, body, idempotencyKey } : { method, path: url.pathname, body });

    const mode = fake.next;
    fake.next = "succeed";
    const hang = () => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    if (mode === "hang") return hang();
    if (mode === "reject") return respond(409, { status: 409, type: "invalid_operation_error", title: "The operation is not allowed." });
    if (mode === "invalid") return respond(400, { status: 400, type: "invalid_parameters_error", title: "Invalid parameters." });
    if (mode === "error") return respond(500, { status: 500, type: "internal_server_error", title: "Something went wrong." });
    if (mode === "succeed_then_hang") {
      await route(url, method, body, idempotencyKey, mode);
      return hang();
    }
    return route(url, method, body, idempotencyKey, mode);
  };

  const achTransitions: Record<string, { from: string[]; apply: (t: AchTransferJson, body: Json) => void }> = {
    submit: { from: ["pending_approval", "pending_submission"], apply: (t) => submitAch(t) },
    settle: {
      from: ["pending_submission", "submitted"],
      apply: (t) => {
        if (t.status === "pending_submission") submitAch(t);
        t.settlement = { settled_at: new Date().toISOString() };
      },
    },
    return: {
      from: ["submitted"],
      apply: (t, body) => {
        t.status = "returned";
        const reason = typeof body.reason === "string" ? body.reason : "no_account";
        t.return = { created_at: new Date().toISOString(), return_reason_code: reason, raw_return_reason_code: "R03", transaction_id: `transaction_fake_${++counter}`, transfer_id: t.id, trace_number: "111122223292834", addenda_information: null };
      },
    },
  };
  const submitAch = (t: AchTransferJson) => {
    t.status = "submitted";
    const now = new Date().toISOString();
    t.submission = { submitted_at: now, trace_number: "058349238292834", effective_date: now.slice(0, 10), expected_funds_settlement_at: now, expected_settlement_schedule: "same_day", administrative_returns_expected_by: now };
  };

  const route = async (url: URL, method: string, body: Json, idempotencyKey: string | null, mode: FakeIncrease["next"]): Promise<Response> => {
    const achRetrieve = /^\/ach_transfers\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && achRetrieve) {
      const transfer = fake.achTransfers.get(achRetrieve[1]);
      return transfer ? respond(200, transfer) : notFound();
    }
    if (method === "GET" && url.pathname === "/ach_transfers") {
      const key = url.searchParams.get("idempotency_key");
      const data = [...fake.achTransfers.values()].filter((t) => key === null || t.idempotency_key === key);
      return respond(200, { data, next_cursor: null });
    }
    const achSimulation = /^\/simulations\/ach_transfers\/([^/]+)\/(submit|settle|return)$/.exec(url.pathname);
    if (method === "POST" && achSimulation) {
      const transfer = fake.achTransfers.get(achSimulation[1]);
      if (!transfer) return notFound();
      const step = achTransitions[achSimulation[2]];
      if (!step.from.includes(transfer.status)) return respond(409, { status: 409, type: "invalid_operation_error", title: "The operation is not allowed." });
      step.apply(transfer, body);
      return respond(200, transfer);
    }
    if (method === "POST" && url.pathname === "/ach_transfers") {
      const signature = JSON.stringify(body);
      const used = idempotencyKey ? achKeys.get(idempotencyKey) : undefined;
      if (used && used.body !== signature) {
        return respond(409, { status: 409, type: "idempotency_key_already_used_error", title: "The idempotency key submitted has already been used.", resource_id: used.id });
      }
      if (used) return respond(200, fake.achTransfers.get(used.id));
      const transfer: AchTransferJson = {
        ...structuredClone(achTransferPending),
        ...body,
        id: `ach_transfer_fake_${++counter}`,
        status: "pending_submission",
        amount: body.amount as number,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      };
      fake.achTransfers.set(transfer.id, transfer);
      if (idempotencyKey) achKeys.set(idempotencyKey, { body: signature, id: transfer.id });
      return respond(200, transfer);
    }

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

/** A thin Increase event for an ACH transfer, as Increase sends it. */
export function achTransferEvent(achTransferId: string, category = "ach_transfer.updated", id = `event_fake_${crypto.randomUUID()}`) {
  return { ...structuredClone(achCreatedEvent), id, category, associated_object_id: achTransferId };
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
