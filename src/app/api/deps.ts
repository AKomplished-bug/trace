import { createDb, createPool, type Db } from "../../db/client";
import type { WebhookVerifier } from "../../integrations/payment-provider";
import { STRIPE_PROVIDER, StripeAdapter } from "../../integrations/stripe";
import { config } from "../../lib/config";

export interface ApiDeps {
  db: Db;
  stripe: StripeAdapter;
  /** Webhook verifiers by the `[provider]` path segment. */
  webhookVerifiers: Readonly<Record<string, WebhookVerifier>>;
}

let deps: ApiDeps | undefined;

/** Process-wide database pool and provider adapters for route handlers, created on first use. */
export function apiDeps(): ApiDeps {
  if (!deps) {
    const env = config();
    const stripe = new StripeAdapter({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
    deps = { db: createDb(createPool(env.DATABASE_URL)), stripe, webhookVerifiers: { [STRIPE_PROVIDER]: stripe } };
  }
  return deps;
}
