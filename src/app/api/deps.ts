import { createDb, createPool, type Db } from "../../db/client";
import { INCREASE_PROVIDER, IncreaseAdapter } from "../../integrations/increase";
import type { WebhookVerifier } from "../../integrations/payment-provider";
import { STRIPE_PROVIDER, StripeAdapter } from "../../integrations/stripe";
import { config } from "../../lib/config";
import { safeErrorForLog } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { startCounterFlush } from "../../services/metrics";

export interface ApiDeps {
  db: Db;
  stripe: StripeAdapter;
  increase: IncreaseAdapter;
  /** Webhook verifiers by the `[provider]` path segment. */
  webhookVerifiers: Readonly<Record<string, WebhookVerifier>>;
}

// On globalThis, not module scope: Next dev re-evaluates modules on every hot reload, and a
// module-level pool would leak a new set of connections each time.
const cache = globalThis as typeof globalThis & { traceApiDeps?: ApiDeps };

/**
 * The one database pool and provider adapters for every route handler and server component,
 * created on first use. Get the database only from here; never create another pool.
 */
export function apiDeps(): ApiDeps {
  if (!cache.traceApiDeps) {
    const env = config();
    const stripe = new StripeAdapter({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
    const increase = new IncreaseAdapter({ apiKey: env.INCREASE_API_KEY, webhookSecret: env.INCREASE_WEBHOOK_SECRET });
    const pool = createPool(env.DATABASE_URL);
    // An idle client losing its connection must not crash the web process.
    pool.on("error", (error) => logger.error({ err: safeErrorForLog(error) }, "idle database client error"));
    const db = createDb(pool);
    // This process's outcome counters (webhooks, funding requests, Ops retries) go to the same table as the worker's.
    startCounterFlush(db, logger);
    cache.traceApiDeps = {
      db,
      stripe,
      increase,
      webhookVerifiers: { [STRIPE_PROVIDER]: stripe, [INCREASE_PROVIDER]: increase },
    };
  }
  return cache.traceApiDeps;
}
