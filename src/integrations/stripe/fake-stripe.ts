import Stripe from "stripe";
import failedIntent from "./fixtures/payment_intent.payment_failed.json";
import succeededIntent from "./fixtures/payment_intent.succeeded.json";
import { StripeAdapter } from ".";

/**
 * Test-only stand-in for the Stripe API behind the real SDK (via its fetch HTTP client), so
 * tests exercise our real requests — idempotency key, params, timeout — without calling Stripe.
 * Handles POST /v1/payment_intents (replaying by Idempotency-Key, like Stripe) and
 * GET /v1/payment_intents/:id.
 */
export const WEBHOOK_SECRET = "whsec_test_fixture_secret";

type Intent = Record<string, unknown> & { id: string };

export interface FakeStripe {
  adapter: StripeAdapter;
  /** PaymentIntents by id; tests may edit them to simulate the provider's view. */
  intents: Map<string, Intent>;
  requests: Array<{ method: string; path: string; idempotencyKey: string | null; body: URLSearchParams }>;
  /** How the next create behaves: succeed, decline the card, or never answer (timeout). */
  nextCreate: "succeed" | "decline" | "hang";
}

export function createFakeStripe({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): FakeStripe {
  let counter = 0;
  const byIdempotencyKey = new Map<string, { status: number; body: unknown }>();
  const fake: FakeStripe = {
    adapter: undefined as unknown as StripeAdapter,
    intents: new Map(),
    requests: [],
    nextCreate: "succeed",
  };

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "request-id": `req_fake_${++counter}` },
    });

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const idempotencyKey = headers.get("idempotency-key");
    fake.requests.push({ method, path: url.pathname, idempotencyKey, body });

    if (method === "POST" && url.pathname === "/v1/payment_intents") {
      const replay = idempotencyKey ? byIdempotencyKey.get(idempotencyKey) : undefined;
      if (replay) return respond(replay.status, replay.body);
      const mode = fake.nextCreate;
      fake.nextCreate = "succeed";
      if (mode === "hang") {
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      const amount = Number(body.get("amount"));
      const metadata = Object.fromEntries(
        [...body.entries()].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]),
      );
      const id = `pi_fake_${++counter}`;
      const base = mode === "decline" ? failedIntent : succeededIntent;
      const intent: Intent = {
        ...structuredClone(base),
        id,
        amount,
        amount_received: mode === "decline" ? 0 : amount,
        latest_charge: `ch_fake_${counter}`,
        metadata,
      };
      fake.intents.set(id, intent);
      const result =
        mode === "decline"
          ? { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined.", payment_intent: intent } } }
          : { status: 200, body: intent };
      if (idempotencyKey) byIdempotencyKey.set(idempotencyKey, result);
      return respond(result.status, result.body);
    }

    const match = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && match) {
      const intent = fake.intents.get(match[1]);
      if (intent) return respond(200, intent);
      return respond(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" } });
    }
    return respond(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${url.pathname})` } });
  };

  fake.adapter = new StripeAdapter({
    secretKey: "sk_test_fake",
    webhookSecret: WEBHOOK_SECRET,
    httpClient: Stripe.createFetchHttpClient(fakeFetch as typeof fetch),
    timeoutMs,
  });
  return fake;
}

/** Puts a fixture's PaymentIntent into the fake so the worker's re-fetch finds it. */
export function seedIntent(fake: FakeStripe, intent: Intent): Intent {
  fake.intents.set(intent.id, structuredClone(intent));
  return intent;
}

/** Signs `payload` like Stripe does, for the webhook route. */
export function signedWebhook(payload: unknown, secret = WEBHOOK_SECRET): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  return { body, signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
}
