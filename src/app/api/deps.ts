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

// On globalThis, not module scope: Next dev re-evaluates modules on every hot reload, and a
// module-level pool would leak a new set of connections each time.
const cache = globalThis as typeof globalThis & { traceApiDeps?: ApiDeps };

/**
 * The one database pool and provider adapters for every route handler, created on first use.
 * Route handlers get the database only from here; never create another pool.
 */
export function apiDeps(): ApiDeps {
  if (!cache.traceApiDeps) {
    const env = config();
    const stripe = new StripeAdapter({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
    cache.traceApiDeps = { db: createDb(createPool(env.DATABASE_URL)), stripe, webhookVerifiers: { [STRIPE_PROVIDER]: stripe } };
  }
  return cache.traceApiDeps;
}
